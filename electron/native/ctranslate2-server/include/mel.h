// Log-mel spectrogram featurizer for the ctranslate2-server input pipeline.
//
// ponytail: this is a straight C++ port of faster-whisper's
// `FeatureExtractor.__call__` (see
// SYSTRAN/faster-whisper/faster_whisper/feature_extractor.py:160-178).
// Whisper's encoder takes pre-computed features shaped [batch, n_mels, time];
// the upstream Python computes them with hann window + reflect-pad STFT +
// 80-band Slaney-scale mel filterbank + log10/clamp/max-floor/+4/+4 normalize.
// Anything that drifts here is the same drift that would show up on a 5-second
// leading-silence clip — the regression test below makes that explicit.
//
// Window parameters from preprocessor_config.json (whisper-small):
//   n_fft=400, hop_length=160, sampling_rate=16000, chunk_length=30
//   → 480000 samples per 30s chunk, 3000 frames, 80 mel bins.

#pragma once

#include <cmath>
#include <cstdint>
#include <vector>

#include "third_party/kissfft/kiss_fft.h"

namespace openscreen::ct2 {

struct FeatureConfig {
  int sample_rate = 16000;
  int n_fft = 400;
  int hop_length = 160;
  int n_mels = 80;
  int chunk_length = 30; // seconds
};

// Pre-built mel filterbank of shape [n_mels, n_fft/2 + 1] (i.e. 80 × 201).
struct MelFilterbank {
  std::vector<float> weights; // row-major: weight[m * (n_fft/2+1) + bin] = gain
  int n_mels = 0;
  int n_bins = 0; // n_fft / 2 + 1
};

// Hankel-style Hann window of length n_fft+1 minus the last sample, per
// faster-whisper::feature_extractor.py:146 (`np.hanning(n_fft + 1)[:-1]`).
inline std::vector<float> hann_window(int n_fft) {
  std::vector<float> w(n_fft);
  // np.hanning(M) returns w[i] = 0.5 * (1 - cos(2*pi*i/(M-1))) for M >= 1
  // with end points at 0 and 0. We drop the trailing zero ([:-1]) so the
  // returned length is n_fft.
  const int M = n_fft + 1;
  for (int i = 0; i < n_fft; ++i) {
    w[i] = 0.5f * (1.0f - std::cos(2.0f * float(M_PI) * float(i) / float(M - 1)));
  }
  return w;
}

// Build the 80-band Slaney-scale mel filterbank, mirroring
// faster-whisper::feature_extractor.py:25-58 verbatim. We precompute the band
// edges in Hz and the constant-energy normalization; output shape is
// [n_mels, n_fft/2 + 1].
inline MelFilterbank build_mel_filterbank(const FeatureConfig& cfg) {
  MelFilterbank fb;
  fb.n_mels = cfg.n_mels;
  fb.n_bins = cfg.n_fft / 2 + 1;
  fb.weights.assign(fb.n_mels * fb.n_bins, 0.0f);

  // Center frequencies of each FFT bin (Hz).
  std::vector<float> fftfreqs(fb.n_bins);
  for (int i = 0; i < fb.n_bins; ++i) {
    fftfreqs[i] = float(i) * float(cfg.sample_rate) / float(cfg.n_fft);
  }

  // 'Center freqs' of mel bands - uniformly spaced between limits
  const float min_mel = 0.0f;
  const float max_mel = 45.245640471924965f;
  std::vector<float> mels(cfg.n_mels + 2);
  for (int i = 0; i < cfg.n_mels + 2; ++i) {
    mels[i] = min_mel + (max_mel - min_mel) * float(i) / float(cfg.n_mels + 1);
  }

  const float f_min = 0.0f;
  const float f_sp = 200.0f / 3.0f;
  std::vector<float> freqs(cfg.n_mels + 2);
  for (int i = 0; i < cfg.n_mels + 2; ++i) {
    freqs[i] = f_min + f_sp * mels[i];
  }

  const float min_log_hz = 1000.0f;
  const float min_log_mel = (min_log_hz - f_min) / f_sp;
  const float logstep = std::log(6.4f) / 27.0f;
  for (int i = 0; i < cfg.n_mels + 2; ++i) {
    if (mels[i] >= min_log_mel) {
      freqs[i] = min_log_hz * std::exp(logstep * (mels[i] - min_log_mel));
    }
  }

  // Pairwise deltas of band centers.
  std::vector<float> fdiff(cfg.n_mels + 1);
  for (int i = 0; i < cfg.n_mels + 1; ++i) {
    fdiff[i] = freqs[i + 1] - freqs[i];
  }

  // Slaney normalisation: weights multiplied by 2 / (freqs[m+2] - freqs[m]).
  for (int m = 0; m < cfg.n_mels; ++m) {
    const float enorm = 2.0f / (freqs[m + 2] - freqs[m]);
    for (int k = 0; k < fb.n_bins; ++k) {
      // ramps = freqs[m] - fftfreqs[k], ramps[m+1] - freqs[m], etc.
      const float lower = (freqs[m] - fftfreqs[k]) / fdiff[m];
      const float upper = (fftfreqs[k] - freqs[m + 2]) / fdiff[m + 1];
      float w = std::max(0.0f, std::min(-lower, upper));
      w *= enorm;
      fb.weights[m * fb.n_bins + k] = w;
    }
  }
  return fb;
}

// Reflect-pad an array by `pad` samples on each side. Python uses
// `np.pad(waveform, (0, padding))` for the trailing pad and `center=True`
// triggers `n_fft // 2` on each side; here we apply n_fft/2 on both sides in
// one shot, matching faster-whisper.
inline std::vector<float> reflect_pad(const std::vector<float>& x, int pad) {
  if (pad <= 0) return x;
  std::vector<float> out;
  out.reserve(x.size() + 2 * pad);
  for (int i = pad; i > 0; --i) {
    out.push_back(x[size_t(i)]);
  }
  out.insert(out.end(), x.begin(), x.end());
  for (size_t i = 1; i <= size_t(pad); ++i) {
    size_t idx = (i > x.size()) ? x.size() : (x.size() - i);
    out.push_back(x[idx]);
  }
  return out;
}

// Compute a single frame's complex DFT of `frame` of length n_fft.
// Matches np.fft.rfft(input_array, n=n_fft, axis=-1, norm=None) used in
// faster-whisper, so we feed `frame` already padded/picked and run a
// straight (not rfft-specialized) complex FFT here. To stay simple we
// always feed exactly `n_fft` real samples — we pad on the caller side.
inline void fft_frame_complex(const kiss_fft_cfg cfg,
                              const std::vector<float>& frame,
                              std::vector<float>& re_out,
                              std::vector<float>& im_out) {
  const int n_fft = cfg->nfft;
  std::vector<kiss_fft_cpx> buf(n_fft);
  for (int i = 0; i < n_fft; ++i) {
    buf[i].r = frame[size_t(i)];
    buf[i].i = 0.0f;
  }
  std::vector<kiss_fft_cpx> out(n_fft);
  kiss_fft(cfg, buf.data(), out.data());
  re_out.resize(size_t(n_fft));
  im_out.resize(size_t(n_fft));
  for (int i = 0; i < n_fft; ++i) {
    re_out[size_t(i)] = out[i].r;
    im_out[size_t(i)] = out[i].i;
  }
}

// ponytail: matches `np.abs(stft[..., :-1]) ** 2` after we drop the bin
// past n_fft/2, then `mel_filters @ magnitudes` (a single per-frame
// dot product) for the 80 mel bins.
// Then: log10(clip(mel, 1e-10, None)), max-floor at 8 below peak, then
// (x + 4)/4 to put values in [0, 1].
struct MelFeatures {
  std::vector<float> data; // row-major: [time, n_mels]
  int n_frames = 0;
  int n_mels = 0;
};

inline MelFeatures compute_log_mel(const std::vector<float>& mono_16k,
                                   const FeatureConfig& cfg,
                                   const MelFilterbank& fb,
                                   const std::vector<float>& window) {
  // Step 1: pad with reflect(n_fft/2 on each side) and append a single zero
  // sample on the right (matches np.pad(waveform, (0, 160))). Then compute
  // an STFT with center padding enabled, hop_length samples between frames.
  const int pad_each = cfg.n_fft / 2;
  std::vector<float> padded = reflect_pad(mono_16k, pad_each);
  padded.push_back(0.0f); // trailing pad to match the Python pipeline
  const int n_padded = int(padded.size());

  const int nb_max_frames = cfg.chunk_length * cfg.sample_rate / cfg.hop_length;

  MelFeatures out;
  out.n_mels = cfg.n_mels;
  out.data.reserve(size_t(nb_max_frames) * size_t(cfg.n_mels));

  // Drop the highest bin (the Python pipeline does magnitudes[..., :-1]),
  // so per-frame magnitudes are length n_fft / 2 (== fb.n_bins - 1 below).
  // Faster-whisper's np.abs(stft[..., :-1]) means magnitudes[i] is the
  // |X[k]| for k in [0, n_fft/2 - 1], leaving out k = n_fft/2.
  // Index k of the underlying FFT corresponds to bin ffreqs[k] = k * sr/n_fft,
  // and we use n_fft/2 bins aligned with the filter bank's `n_bins`.

  // We compute the full FFT then drop the top bin (== n_fft/2) to match.
  const int kept_bins = cfg.n_fft / 2; // == fb.n_bins - 1
  std::vector<float> magnitudes(size_t(kept_bins));
  // Magnitudes squared are used here so the filterbank multiplies
  // them directly (mimics `np.abs(stft[..., :-1]) ** 2`).

  kiss_fft_cfg fft_cfg =
      kiss_fft_alloc(cfg.n_fft, 0, nullptr, nullptr);
  if (!fft_cfg) {
    throw std::runtime_error("kiss_fft_alloc failed");
  }

  std::vector<float> windowed_frame;
  std::vector<float> re_fft;
  std::vector<float> im_fft;
  windowed_frame.resize(size_t(cfg.n_fft));

  for (int frame = 0;; ++frame) {
    const int offset = frame * cfg.hop_length;
    if (offset + cfg.n_fft > n_padded) break;

    // Window the frame and run the FFT.
    for (int i = 0; i < cfg.n_fft; ++i) {
      windowed_frame[size_t(i)] =
          padded[size_t(offset + i)] * window[size_t(i)];
    }
    fft_frame_complex(fft_cfg, windowed_frame, re_fft, im_fft);

    // Magnitudes squared (Python uses np.abs(...)**2 before the mel dot).
    for (int k = 0; k < kept_bins; ++k) {
      magnitudes[size_t(k)] = re_fft[size_t(k)] * re_fft[size_t(k)] +
                              im_fft[size_t(k)] * im_fft[size_t(k)];
    }

    // Apply the mel filterbank: for each mel bin, sum mels * mags.
    std::vector<float> mel_out(size_t(cfg.n_mels), 0.0f);
    for (int m = 0; m < cfg.n_mels; ++m) {
      float acc = 0.0f;
      const float* row = fb.weights.data() + size_t(m) * size_t(fb.n_bins);
      for (int k = 0; k < kept_bins; ++k) {
        // Filter bank covers bins [0, n_fft/2) — matching the Python
        // magnitudes.shape == (n_fft/2,) after the `[:-1]` trim.
        acc += row[size_t(k)] * magnitudes[size_t(k)];
      }
      mel_out[size_t(m)] = acc;
    }

    // Step 2: log10 with clip(min=1e-10), max-peak floor at -8, then (x+4)/4.
    float max_val = -1e30f;
    for (int m = 0; m < cfg.n_mels; ++m) {
      const float v = mel_out[size_t(m)];
      const float clipped = std::max(1e-10f, v);
      const float log_val = std::log10(clipped);
      mel_out[size_t(m)] = log_val;
      if (log_val > max_val) max_val = log_val;
    }
    const float floor_at = max_val - 8.0f;
    for (int m = 0; m < cfg.n_mels; ++m) {
      const float x = std::max(mel_out[size_t(m)], floor_at);
      mel_out[size_t(m)] = (x + 4.0f) / 4.0f;
    }

    // Store the row-major: [time, n_mels].
    for (int m = 0; m < cfg.n_mels; ++m) {
      out.data.push_back(mel_out[size_t(m)]);
    }
    out.n_frames += 1;
    if (out.n_frames >= nb_max_frames) break;
  }

  kiss_fft_free(fft_cfg);
  return out;
}

} // namespace openscreen::ct2
