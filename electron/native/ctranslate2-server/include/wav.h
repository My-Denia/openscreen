// Minimal PCM WAV loader for the ctranslate2-server input pipeline.
//
// ponytail: the wire contract (electron/stt/wav.ts::writeSamplesAsWav) emits
// exactly 16-bit LE mono 16 kHz PCM with a fixed 44-byte header. We validate
// those four fields at load time and refuse anything else — the upstream is
// fully internal, so we don't need to handle WAV's kitchen-sink of format
// tags. Adding accept handling would just be a 500-from-silence tail-chase.

#pragma once

#include <cstdint>
#include <stdexcept>
#include <vector>

namespace openscreen::ct2 {

struct WavData {
  std::vector<float> samples; // mono, normalized to [-1, 1]
  int sample_rate = 0;
};

inline WavData read_pcm_wav(const void* data, size_t size) {
  // Header layout: "RIFF" (4) + ChunkSize (4) + "WAVE" (4) + "fmt " (4) +
  //   Subchunk1Size (4) + AudioFormat (2) + NumChannels (2) +
  //   SampleRate (4) + ByteRate (4) + BlockAlign (2) + BitsPerSample (2) +
  //   "data" (4) + Subchunk2Size (4) [+ extension byte in `fmt ` ext.]
  // We assume the standard 44-byte header that writeSamplesAsWav emits.
  static constexpr size_t kHeaderBytes = 44;
  if (size < kHeaderBytes) {
    throw std::runtime_error("WAV: input shorter than the 44-byte PCM header");
  }
  const uint8_t* p = static_cast<const uint8_t*>(data);
  // No endian-safe read of magic numbers; the contract guarantees LE.
  auto fourcc = [&](size_t off) -> uint32_t {
    return uint32_t{p[off]} | (uint32_t{p[off + 1]} << 8) |
           (uint32_t{p[off + 2]} << 16) | (uint32_t{p[off + 3]} << 24);
  };
  if (fourcc(0) != 0x46464952u /* "RIFF" */) {
    throw std::runtime_error("WAV: missing 'RIFF' magic");
  }
  if (fourcc(8) != 0x45564157u /* "WAVE" */) {
    throw std::runtime_error("WAV: missing 'WAVE' marker");
  }
  if (fourcc(12) != 0x20746d66u /* "fmt " */) {
    throw std::runtime_error("WAV: missing 'fmt ' chunk header");
  }
  // Subchunk1 size must be 16 for our layout; reject extensible headers.
  const uint32_t fmt_size =
      uint32_t{p[16]} | (uint32_t{p[17]} << 8) | (uint32_t{p[18]} << 16) |
      (uint32_t{p[19]} << 24);
  if (fmt_size != 16) {
    throw std::runtime_error("WAV: extensible or non-PCM header not supported");
  }
  // AudioFormat must be 1 (PCM).
  if (p[20] != 1 || p[21] != 0) {
    throw std::runtime_error("WAV: only uncompressed PCM is supported");
  }
  // NumChannels must be 1.
  if (p[22] != 1 || p[23] != 0) {
    throw std::runtime_error("WAV: only mono files are supported");
  }
  // SampleRate must be 16000 little-endian.
  const uint32_t sample_rate = uint32_t{p[24]} | (uint32_t{p[25]} << 8) |
                               (uint32_t{p[26]} << 16) |
                               (uint32_t{p[27]} << 24);
  if (sample_rate != 16000) {
    throw std::runtime_error("WAV: sample rate must be 16000 Hz");
  }
  if (p[34] != 16 || p[35] != 0) {
    throw std::runtime_error("WAV: only 16-bit samples are supported");
  }
  if (fourcc(36) != 0x61746164u /* "data" */) {
    throw std::runtime_error("WAV: missing 'data' chunk header");
  }
  const uint32_t data_size = uint32_t{p[40]} | (uint32_t{p[41]} << 8) |
                             (uint32_t{p[42]} << 16) |
                             (uint32_t{p[43]} << 24);
  if (size < kHeaderBytes + data_size) {
    throw std::runtime_error("WAV: payload truncated relative to data chunk");
  }
  if (data_size % 2 != 0) {
    throw std::runtime_error("WAV: 16-bit mono data must have an even byte length");
  }

  WavData out;
  out.sample_rate = static_cast<int>(sample_rate);
  out.samples.reserve(data_size / 2);
  for (size_t i = 0; i < data_size / 2; ++i) {
    int16_t s = int16_t{p[kHeaderBytes + 2 * i]} |
                (int16_t{p[kHeaderBytes + 2 * i + 1]} << 8);
    // Hard-clip before normalize; matches the Node writer's behavior on the
    // -1/+1 input bounds (writeSamplesAsWav clips to int16 range).
    const float clamped = std::max(-1.0f, std::min(1.0f, s / 32768.0f));
    out.samples.push_back(clamped);
  }
  return out;
}

} // namespace openscreen::ct2
