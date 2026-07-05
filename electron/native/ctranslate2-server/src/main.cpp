// ctranslate2-server: real implementation.
//
// ponytail: this is the load-bearing wire between the Electron main process and
// the CTranslate2 runtime. The HTTP contract is documented at the top of
// `electron/native/ctranslate2-server/README.md` and on the Node side in
// `electron/stt/ctranslate2Server.ts::runMultipartInfer`. The Node wrapper
// expects a verbose_json response shape that matches whisper-server's, so
// the renderer-side wire stays put.

#include <atomic>
#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include <ctranslate2/models/whisper.h>
#include <ctranslate2/storage_view.h>
#include <httplib.h>
#include <nlohmann/json.hpp>

#include "mel.h"
#include "tokenizer.h"
#include "wav.h"

using json = nlohmann::json;

namespace {

struct ServerConfig {
  std::string model_dir;
  std::string host = "127.0.0.1";
  int port = 0;
  int threads = std::max(1u, std::thread::hardware_concurrency());
  bool use_cuda = false;
  int sample_rate = 16000;
  int n_fft = 400;
  int hop_length = 160;
  int n_mels = 80;
  int chunk_length = 30;

  static ServerConfig from_env(int arg_port) {
    ServerConfig c;
    if (const char *p = std::getenv("OPENSCREEN_CT2_MODEL_DIR")) c.model_dir = p;
    if (const char *p = std::getenv("OPENSCREEN_CT2_HOST")) c.host = p;
    if (const char *p = std::getenv("OPENSCREEN_CT2_PORT")) c.port = std::atoi(p);
    if (const char *p = std::getenv("OPENSCREEN_CT2_THREADS")) c.threads = std::atoi(p);
    if (const char *p = std::getenv("OPENSCREEN_CT2_CUDA")) c.use_cuda = std::atoi(p) != 0;
    if (arg_port > 0) c.port = arg_port;
    return c;
  }
};

void log(const std::string& msg) {
  std::cerr << "[ctranslate2-server] " << msg << std::endl;
  std::cerr.flush();
}

openscreen::ct2::WhisperTokenizer load_tokenizer(const std::string& model_dir) {
  // Read model.bin and tokenizer.json from the model directory.
  std::string tokenizer_path = model_dir + "/tokenizer.json";
  std::ifstream in(tokenizer_path);
  if (!in) {
    throw std::runtime_error("cannot open tokenizer.json at " + tokenizer_path);
  }
  json tok;
  in >> tok;

  std::unordered_map<std::string, int> vocab;
  std::unordered_map<int, std::string> added;

  // added_tokens: array of { id, content, ... }.
  for (const auto& entry : tok["added_tokens"]) {
    int id = entry["id"].get<int>();
    std::string content = entry["content"].get<std::string>();
    added.emplace(id, content);
  }
  // model.vocab: map of { token: id }.
  for (auto it = tok["model"]["vocab"].begin(); it != tok["model"]["vocab"].end();
       ++it) {
    const std::string& piece = it.key();
    int id = it.value().get<int>();
    vocab.emplace(piece, id);
  }
  return openscreen::ct2::WhisperTokenizer(std::move(vocab), std::move(added));
}

// Returns the audio language ISO 639-1 code via the model's detect_language
// call. ctranslate2 emits the token form (e.g. "<|en|>") which we translate
// back via the tokenizer.
struct LanguageDetection {
  std::string language;  // ISO 639-1 ("en", "fr")
  float probability = 0;
};

LanguageDetection detect_language(
    ctranslate2::models::Whisper& model,
    const openscreen::ct2::WhisperTokenizer& tok,
    const ctranslate2::StorageView& features) {
  LanguageDetection out;
  auto futures = model.detect_language(features);
  if (futures.empty()) return out;
  auto top = futures[0].get();
  if (top.empty()) return out;
  // top is a vector of pairs of (token, prob). Render the token.
  const std::string& lang_token = top[0].first;
  out.probability = top[0].second;
  std::cerr << "[ct2] detect_language: raw_lang_token='" << lang_token << "'"
            << std::endl;
  if (lang_token.size() >= 6 && lang_token.compare(0, 2, "<|") == 0 &&
      lang_token.back() == '>') {
    // CT2 returns e.g. "<|en|>" or "<|de|>". Some models return the bare
    // ISO code (without the wrapper) — preserve it verbatim either way so
    // build_prompt can pick the right vocab lookup.
    out.language = lang_token;
  } else {
    out.language = "<|" + lang_token + "|>";
  }
  return out;
}

// Build the SOT prompt: [sot, language, transcribe, notimestamps] (matches
// faster-whisper's default transcribe-mode prompt).
std::vector<int> build_prompt(
    const openscreen::ct2::WhisperTokenizer& tok,
    const std::string& language) {
  std::vector<int> p;
  p.push_back(tok.sot_id());
  // ponytail: caller passes either "<|en|>" (detection output) or "en"
  // (caller-supplied). Mirror what the Python tokenizer would do: try
  // the literal token first, fall back to wrapping.
  std::string lang_token = language;
  // ponytail: `<|en|>` is 6 chars: '<', '|', 'e', 'n', '|', '>'. The first
  // TWO chars are '<|'; the first THREE are '<|e'. Comparing substr(0, 3)
  // against "<|" never matches — caught at the bug-5-second-silence test.
  // Compare the first two chars instead.
  if (lang_token.size() < 6 || lang_token.compare(0, 2, "<|") != 0 ||
      lang_token.back() != '>') {
    lang_token = "<|" + language + "|>";
  }
  std::cerr << "[ct2] build_prompt: language='" << language
            << "' lang_token='" << lang_token << "'" << std::endl;
  p.push_back(tok.id_for(lang_token));
  p.push_back(tok.id_for("<|transcribe|>"));
  p.push_back(tok.id_for("<|notimestamps|>"));
  return p;
}

// Render an emitted id sequence to UTF-8 text. Drops <|...|> special tokens
// entirely; merges the remainder into a single string and trims stray
// leading whitespace (matches the Python tokenizer's behavior).
std::string decode_tokens(
    const std::vector<int>& ids,
    const openscreen::ct2::WhisperTokenizer& tok) {
  std::string out;
  for (int id : ids) {
    if (id == tok.eot_id()) break;
    if (id >= 50256) continue; // special/whitespace; not text
    std::string piece;
    if (!tok.try_render(id, &piece)) continue;
    out += piece;
  }
  // Caller decides what to do with leading whitespace; we leave it as-is.
  return out;
}

// Split the emitted token sequence into "segments" that look like whisper's
// verbose_json output. Whisper emits alternating timestamp tokens and
// text-token blocks; each timestamp token marks the boundary between two
// text-only spans.
//
// Format:     <|0.00|> token token <|1.84|> token token
// Timestamps are at fixed 0.02s granularity (faster-whisper.time_precision).
struct DecodedSegment {
  float start = 0;
  float end = 0;
  std::string text;
  std::vector<int> token_ids; // raw ids (text only; timestamps stripped)
};

inline bool is_timestamp_token(int id, int ts_begin) {
  return id >= ts_begin;
}

std::vector<DecodedSegment> split_segments(
    const std::vector<int>& ids,
    int timestamp_begin,
    float time_precision) {
  std::vector<DecodedSegment> segs;
  std::optional<DecodedSegment> cur;
  float prev_ts = 0.0f;
  for (int id : ids) {
    if (is_timestamp_token(id, timestamp_begin)) {
      const float t = (id - timestamp_begin) * time_precision;
      if (cur) {
        cur->end = t;
        prev_ts = t;
        segs.push_back(std::move(*cur));
        cur.reset();
      } else {
        prev_ts = t;
      }
      continue;
    }
    // Skip everything except regular text tokens; treat special tokens as
    // text (they're functionally text markers when not timestamps).
    if (!cur) {
      cur = DecodedSegment{};
      cur->start = prev_ts;
    }
    cur->token_ids.push_back(id);
  }
  if (cur) {
    // Trail segment with no trailing timestamp.
    cur->end = prev_ts + 0.05f;
    segs.push_back(std::move(*cur));
  }
  return segs;
}

// Build the response JSON.
json to_response_json(
    const std::vector<DecodedSegment>& segments,
    const openscreen::ct2::WhisperTokenizer& tok,
    const std::string& language) {
  json out;
  out["language"] = language;
  out["detected_language"] = language;
  json segs = json::array();
  for (size_t i = 0; i < segments.size(); ++i) {
    const auto& s = segments[i];
    json seg;
    seg["id"] = int(i);
    seg["text"] = decode_tokens(s.token_ids, tok);
    seg["start"] = s.start;
    seg["end"] = s.end;
    segs.push_back(std::move(seg));
  }
  out["segments"] = std::move(segs);
  return out;
}

} // namespace

int main(int argc, char** argv) {
  ServerConfig cfg = ServerConfig::from_env(0);
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    if (a == "--model" && i + 1 < argc) cfg.model_dir = argv[++i];
    else if (a == "--host" && i + 1 < argc) cfg.host = argv[++i];
    else if (a == "--port" && i + 1 < argc) cfg.port = std::atoi(argv[++i]);
    else if (a == "--threads" && i + 1 < argc) cfg.threads = std::atoi(argv[++i]);
    else if (a == "--cuda") cfg.use_cuda = true;
  }
  if (cfg.model_dir.empty()) {
    std::cerr << "FATAL: --model / OPENSCREEN_CT2_MODEL_DIR is required" << std::endl;
    return 2;
  }

  log("boot: model_dir=" + cfg.model_dir +
      " host=" + cfg.host +
      " port=" + std::to_string(cfg.port) +
      " threads=" + std::to_string(cfg.threads) +
      " cuda=" + std::string(cfg.use_cuda ? "on" : "off"));

  // Load the model. INT8 on CPU dodges the SGEMM backend (we built with
  // no BLAS); INT8 + fp16-on-intel both work without BLAS. See
  // docs/engineering/stt-ctranslate2-migration.md § Constraints for the
  // why of the no-BLAS build.
  std::unique_ptr<ctranslate2::models::Whisper> model;
  try {
    ctranslate2::ReplicaPoolConfig pool_config;
    pool_config.num_threads_per_replica = cfg.threads;
    model = std::make_unique<ctranslate2::models::Whisper>(
        cfg.model_dir,
        cfg.use_cuda ? ctranslate2::Device::CUDA : ctranslate2::Device::CPU,
        /*compute_type=*/cfg.use_cuda ? ctranslate2::ComputeType::FLOAT16
                                       : ctranslate2::ComputeType::FLOAT32,
        std::vector<int>{0},
        /*tensor_parallel=*/false,
        pool_config);
  } catch (const std::exception& e) {
    std::cerr << "FATAL: model load failed: " << e.what() << std::endl;
    return 3;
  }
  log("model loaded: " +
      std::string(model->is_multilingual() ? "multilingual" : "english-only") +
      " n_mels=" + std::to_string(model->n_mels()));

  // Load the tokenizer.
  openscreen::ct2::WhisperTokenizer tok = load_tokenizer(cfg.model_dir);
  // ponytail: sanity probe — Whisper's vocabulary should always have a
  // <|en|> entry in added_tokens. If this throws, the tokenizer.json
  // is malformed and we should fail loudly before serving any traffic.
  log("tokenizer sanity: id(<|en|>)=" + std::to_string(tok.id_for("<|en|>")));
  // Whisper's vocabulary is canonical: timestamp_begin = no_timestamps_id + 1.
  // Look it up rather than hard-coding in case a future model shifts IDs.
  int ts_begin = -1;
  try {
    int no_ts_id = tok.id_for("<|notimestamps|>");
    ts_begin = no_ts_id + 1;
  } catch (const std::exception& e) {
    std::cerr << "FATAL: tokenizer missing <|notimestamps|>: " << e.what() << std::endl;
    return 3;
  }

  // Set up the HTTP server.
  httplib::Server svr;
  // Bump payload_max_length because /inference accepts an MP4-worth of audio.
  svr.set_payload_max_length(2 * 1024 * 1024 * 1024);
  svr.set_read_timeout(60, 0);
  svr.set_write_timeout(60, 0);

  // Readiness probe.
  svr.Get("/", [](const httplib::Request&, httplib::Response& res) {
    res.set_content("ok\n", "text/plain");
  });

  // Mutual exclusion around the model — a single instance serializes
  // inferences. Same constraint as WhisperServerManager had.
  std::mutex model_mu;

  svr.Post("/inference", [&model, &tok, ts_begin, &model_mu, &cfg](
                                const httplib::Request& req,
                                httplib::Response& res) {
    // Pull the WAV file from the multipart payload (whisper-server wire).
    auto it = req.files.find("file");
    if (it == req.files.end()) {
      res.status = 400;
      res.set_content("{\"error\":\"missing 'file' form field\"}", "application/json");
      return;
    }
    const auto& file_entry = it->second;
    openscreen::ct2::WavData wav;
    try {
      wav = openscreen::ct2::read_pcm_wav(
          file_entry.content.data(), file_entry.content.size());
    } catch (const std::exception& e) {
      res.status = 400;
      res.set_content(std::string("{\"error\":\"") + e.what() + "\"}",
                       "application/json");
      return;
    }

    std::string language = "en";
    if (auto p = req.get_file_value("language"); !p.content.empty()) {
      language = p.content;
    } else {
      const auto& kv = req.params.find("language");
      if (kv != req.params.end()) language = kv->second;
    }
    if (language == "auto") language = "";

    // Compute log-mel features.
    openscreen::ct2::FeatureConfig fcfg;
    fcfg.sample_rate = cfg.sample_rate;
    fcfg.n_fft = cfg.n_fft;
    fcfg.hop_length = cfg.hop_length;
    fcfg.n_mels = cfg.n_mels;
    fcfg.chunk_length = cfg.chunk_length;
    auto window = openscreen::ct2::hann_window(fcfg.n_fft);
    auto fb = openscreen::ct2::build_mel_filterbank(fcfg);
    auto features = openscreen::ct2::compute_log_mel(wav.samples, fcfg, fb, window);

    // Pad or trim to chunk_length frames.
    const int nb_max = fcfg.chunk_length * fcfg.sample_rate / fcfg.hop_length;
    std::vector<float> pad(1ULL * nb_max * fcfg.n_mels, 0.0f);
    if (features.n_frames > nb_max) features.n_frames = nb_max;
    const size_t keep = size_t(features.n_frames) * size_t(fcfg.n_mels);
    std::copy(features.data.begin(), features.data.begin() + keep, pad.begin());
    features.data = std::move(pad);
    features.n_frames = nb_max;

    // Wrap the feature buffer in a ctranslate2::StorageView of shape
    // [1, n_mels, n_frames] in float32.
    ctranslate2::Shape feat_shape{1, int64_t(fcfg.n_mels), int64_t(features.n_frames)};
    auto sv_features = std::make_shared<ctranslate2::StorageView>(
        feat_shape, std::move(features.data), ctranslate2::Device::CPU);

    ctranslate2::models::WhisperGenerationResult gen;
    std::vector<int> emitted_ids;
    std::string chosen_language = language;

    try {
      std::lock_guard<std::mutex> lk(model_mu);
      if (chosen_language.empty()) {
        LanguageDetection det = detect_language(*model, tok, *sv_features);
        if (!det.language.empty()) {
          chosen_language = det.language;
        } else {
          chosen_language = "en";
        }
      }
      std::vector<std::vector<size_t>> prompts;
      auto int_prompt = build_prompt(tok, chosen_language);
      std::vector<size_t> int_prompt_sz;
      int_prompt_sz.reserve(int_prompt.size());
      for (int t : int_prompt) int_prompt_sz.push_back(static_cast<size_t>(t));
      prompts.push_back(std::move(int_prompt_sz));

      // Run the encode + decode loop for the single chunk.
      ctranslate2::models::WhisperOptions opts;
      opts.beam_size = 5;
      opts.patience = 1.0f;
      opts.length_penalty = 1.0f;
      opts.sampling_temperature = 0.0f;
      opts.max_initial_timestamp_index = 0; // Ponytail: timestamps are part of the output.
      opts.return_scores = true;

      auto gen_futures =
          model->generate(/*features=*/*sv_features, std::move(prompts), opts);
      if (gen_futures.empty()) {
        res.status = 500;
        res.set_content("{\"error\":\"empty generation\"}", "application/json");
        return;
      }
      // ponytail: std::future<T>::get() is a move-only call, so capture the
      // result by value (not by reference) to avoid the rvalue->T& warning.
      auto first_gen = gen_futures[0].get();
      if (first_gen.sequences_ids.empty()) {
        res.status = 500;
        res.set_content("{\"error\":\"empty sequences_ids\"}", "application/json");
        return;
      }
      emitted_ids.assign(first_gen.sequences_ids[0].begin(),
                        first_gen.sequences_ids[0].end());
    } catch (const std::exception& e) {
      res.status = 500;
      res.set_content(std::string("{\"error\":\"") + e.what() + "\"}",
                       "application/json");
      return;
    }

    // Split the emitted token sequence into phrase segments.
    std::vector<DecodedSegment> segments = split_segments(
        emitted_ids, ts_begin, /*time_precision=*/0.02f);

    json reply = to_response_json(segments, tok, chosen_language);
    res.set_content(reply.dump(), "application/json");
  });

  // Bind + listen.
  if (cfg.port == 0) {
    cfg.port = svr.bind_to_any_port(cfg.host);
  } else {
    if (!svr.bind_to_port(cfg.host, cfg.port)) {
      std::cerr << "FATAL: bind_to_port(" << cfg.host << ":" << cfg.port
                << ") failed" << std::endl;
      return 4;
    }
  }
  log("listening on " + cfg.host + ":" + std::to_string(cfg.port));
  if (!svr.listen_after_bind()) {
    std::cerr << "FATAL: listen_after_bind failed" << std::endl;
    return 5;
  }
  return 0;
}
