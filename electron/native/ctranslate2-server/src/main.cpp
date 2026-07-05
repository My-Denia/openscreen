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
#include <iostream>
#include <mutex>
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
    const ctranslate2::models::Whisper& model,
    const openscreen::ct2::WhisperTokenizer& tok,
    const ctranslate2::StorageView& features) {
  LanguageDetection out;
  auto futures = model.detect_language(features);
  if (futures.empty()) return out;
  auto& top = futures[0].get();
  if (top.empty()) return out;
  // top is a vector of pairs of (token, prob). Render the token.
  const std::string& lang_token = top[0].first;
  out.probability = top[0].second;
  // Strip the <|...|> wrapper.
  if (lang_token.size() >= 4 && lang_token.substr(0, 3) == "<|" &&
      lang_token.back() == '>') {
    out.language = lang_token.substr(3, lang_token.size() - 4);
  } else {
    out.language = lang_token;
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
  p.push_back(tok.id_for("<|" + language + "|>"));
  p.push_back(tok.id_for("<|transcribe|>"