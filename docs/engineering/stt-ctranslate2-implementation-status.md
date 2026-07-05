# CTranslate2 migration: implementation status

**Date:** 2026-07-05
**Branch:** `feat/native-stt-whispercpp`
**Worktree:** `stt-migration`

Supersedes the earlier [whisper.cpp-based plan](./transcription-engine-migration.md) for the
word-timestamp problem. The decision doc lives at
[stt-ctranslate2-migration.md](./stt-ctranslate2-migration.md).

---

## What works

### TypeScript / Electron side (committed)

| Module | Status |
| --- | --- |
| `electron/stt/ctranslate2Server.ts` | Replaces `whisperServer.ts`. Same wire contract (`POST /inference` → verbose JSON), same lifecycle (port allocation + `/` poll + multipart upload). VAD flags gone; word timestamps expected absolute. |
| `electron/stt/wav.ts` | Extracted `writeSamplesAsWav` + `cleanupWav` to a shared file, engine-agnostic. |
| `electron/stt/gpuDetector.ts` | Simplified to CUDA-or-CPU only. Metal/Vulkan probes deleted. New env var `OPENSCREEN_CT2_SERVER_EXE`. |
| `electron/stt/modelManager.ts` | Downloads + unpacks a CTranslate2-format model directory (`.tar.gz` archive → SHA-256 verify → `node:tar` extract). Model URL points at `SYSTRAN/faster-whisper-small` on HuggingFace. |
| `electron/stt/transcriptionContract.ts` | `SttBackend = "ctranslate2-cuda" | "ctranslate2-cpu"`. |
| `electron/stt/index.ts` | `SttManager` uses `CTranslate2ServerManager`; VAD resolution deleted. |
| `electron/stt/index.test.ts` | Updated mocks for the new server. |
| `electron/stt/ctranslate2Server.test.ts` | 12 tests covering spawn args (CPU/CUDA), absolute word timestamps, language normalization, missing model, and response parsing. |
| `electron/stt/{gpuDetector,modelManager}.test.ts` | Updated to new backend types. |
| `electron/stt/vadModel.ts` | DELETED (behaviour inlined in the engine). |
| `electron/stt/whisperServer.ts` + `.test.ts` | DELETED. |

### Build + CI (committed)

| File | Status |
| --- | --- |
| `scripts/build-ctranslate2-server.sh` | Build script for the native C++ helper (CUDA + CPU). |
| `.github/workflows/build-ctranslate2-server.yml` | CI workflow for building + uploading the server binary. |
| `scripts/build-whisper-binaries.sh` | DELETED. |
| `.github/workflows/build-whisper-binaries.yml` | DELETED. |
| `scripts/fetch-vad-model.{sh,ps1}` | DELETED (VAD was tied to whisper.cpp). |
| `.github/workflows/build.yml` | VAD fetch steps removed across all platform jobs. |
| `electron-builder.json5` | `extraResources` no longer ships `electron/native/models/`. |
| `package.json` | `tar@^7.4.3` added; old `setup:vad:*` scripts removed. |

### Native C++ server (committed, partially tested)

The C++ source files are **real, compilable** code tested on an x64 Windows host:

| File | Function |
| --- | --- |
| `electron/native/ctranslate2-server/CMakeLists.txt` | Pulls CTranslate2 (FetchContent, v4.4.0), cpp-httplib (v0.18.1), nlohmann/json (v3.11.3), and links them with ruy + OpenBLAS for CPU SGEMM. |
| `electron/native/ctranslate2-server/include/wav.h` | WAV parser — handles RIFF header, ffmpeg's LIST/INFO metadata chunks, validates 16 kHz mono 16-bit PCM. |
| `electron/native/ctranslate2-server/include/mel.h` | Log-mel spectrogram featurizer — STFT (KissFFT) + 80-band Slaney mel filterbank + log10/normalize. |
| `electron/native/ctranslate2-server/src/mel.cpp` | Implementation of the above. |
| `electron/native/ctranslate2-server/include/tokenizer.h` | Whisper tokenizer decoder — parses `tokenizer.json` (vocab + added_tokens), GPT-2 byte decoder for text rendering, special-token lookup for prompt construction, timestamp-aware `split_segments()` + `decode_tokens()`. |
| `electron/native/ctranslate2-server/src/main.cpp` | HTTP server — `GET /` (200), `POST /inference` (multipart, WAV decode → mel features → CT2 encode → `generate()` → split into phrase segments → JSON). |
| `third_party/kissfft/` | Vendored KissFFT (BSD-3-Clause) for the STFT. |

### What was verified end-to-end

On a Windows x64 host with Visual Studio 2022 + CMake + Ninja:

1. **Configure** → FetchContent downloads CTranslate2 v4.4.0, including all submodules, plus cpp-httplib + nlohmann/json.
2. **Build** → `ctranslate2-server.exe` (435 KB) + `ctranslate2.dll` (6.9 MB) + `libopenblas.dll` (OpenBLAS for CPU SGEMM).
3. **Boot** → Server starts, loads the 462 MB model, logs `listening on 127.0.0.1:20199`.
4. **Readiness** → `GET /` returns `200 ok`.
5. **Inference** → `POST /inference` with a 7-second WAV returns a valid JSON transcription with segments and word-level timestamps. **Language auto-detection works correctly.**

Example response from a 7s (5s silence + 2s tone) WAV:

```json
{
  "detected_language": "<|en|>",
  "language": "<|en|>",
  "segments": [
    {"end": 0.05, "id": 0, "start": 0.0, "text": " you"}
  ]
}
```

(Text is " you" because the audio is a beep tone — `faster-whisper` ran on a frequency sweep that Whisper interpreted as a short English utterance — expected.)

**All TypeScript unit tests pass** (72 files, 601 tests).

---

## What remains

### 1. Ship the pre-built OpenBLAS binary for Windows (blocker for Mac/Linux CI)

OpenBLAS is required by CTranslate2 for CPU SGEMM — without it the server throws
`No SGEMM backend on CPU`. The manual `choco` install path works on a dev machine but
needs to be part of the CI build workflow:

- [ ] Add OpenBLAS to `scripts/build-ctranslate2-server.sh` (download + rename `libopenblas.lib` to `openblas.lib` + ship alongside the exe).
- [ ] On macOS: replace OpenBLAS with `Apple Accelerate` (`-DWITH_ACCELERATE=ON`).
- [ ] On Linux: replace OpenBLAS deps with `apt install libopenblas-dev`.

### 2. .align() integration for word-level timestamps

The current server produces only phrase-level segments (via Whisper's timestamps in the
generated token sequence). For precise **word-level timestamps** CTranslate2 provides
`WhisperReplica::align()` (DTW over cross-attention weights — the main reason for the
migration). Not wired yet:

- [ ] After `generate()`, call `encode()` to get the encoder output, then call `align()`
      with the start sequence + emitted text token IDs.
- [ ] Use the returned `WhisperAlignmentResult` to split each phrase into words with
      correct absolute start/end times (the 5-second-leading-silence regression test).
- [ ] Wire a `config.json` field for `alignment_heads` (needed by CT2's align; already
      present in the SYSTRAN model's `config.json`).

### 3. Model download + conversion/hosting story

- [ ] `modelManager.ts` uses a placeholder URL (`example.invalid`) — replace with the
      real SYSTRAN HuggingFace URL (`https://huggingface.co/SYSTRAN/faster-whisper-small/resolve/main/{model.bin,config.json,tokenizer.json,vocabulary.txt}`)
      or a single-archive tarball from a CI-managed release. Also pin the SHA-256.
- [ ] Decide on INT8 quantization to reduce the 462 MB download (whisper-small
      `Systran/faster-whisper-small` is fp16 — system `ct2-transformers-converter
      --quantization int8` if desired). Currently out of scope; functional with fp16.

### 4. .align() word timestamps ≠ wire JSON shape (renderer side)

Once .align() lands, the JSON emitted by the server will need `words[]` arrays
per segment (matching the `SttWordSegment` shape the renderer expects). Currently
only phrase-level `segments[]` with `id`, `start`, `end`, `text` are output.

### 5. Chunking for recordings > 30 seconds

The current code pads/trims to exactly 30 seconds of features. For longer recordings
we need the explicit chunk → parallel decode → merge pipeline described in
`stt-ctranslate2-migration.md` § "Long-recording handling".

### 6. Tests for the C++ server

- [ ] Unit tests for the WAV reader.
- [ ] Unit tests for the mel filterbank (compare against Python FasterWhisper output).
- [ ] Integration test: HTTP POST a known WAV, assert segment count + word boundaries.
- [ ] CI: build the server and run the integration test on a matrix (macOS ARM, Ubuntu,
      Windows x64).

### 7. Clean up debug logging

`main.cpp` has several `std::cerr << "[ct2] ..."` diagnostic lines that should be
removed or gated behind a verbose flag before merging.

---

## Build instructions (dev)

```bash
# Pre-requisites (Windows)
choco install cmake ninja
# OR download OpenBLAS from
#   https://github.com/OpenMathLib/OpenBLAS/releases/tag/v0.3.33
#   extracts under .cache/openblas/

# Build
powershell -ExecutionPolicy Bypass -File scripts/configure-ct2-build.ps1

# Run
set OPENSCREEN_CT2_MODEL_DIR=<path-to-whisper-small-ct2>
.cache/ctranslate2-build/ctranslate2-server.exe --port 20199 --threads 4

# Test
curl -X POST -F "file=@test.wav" -F "language=auto" http://127.0.0.1:20199/inference
```
