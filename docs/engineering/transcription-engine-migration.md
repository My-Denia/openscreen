# Native STT migration: from `@xenova/transformers` (browser WASM) to `whisper.cpp` + forced alignment

## Goal

Replace the in-browser `@xenova/transformers` Whisper pipeline with a native
`whisper.cpp` recognizer plus `onnxruntime-node` forced alignment, both
running in the Electron main process. Ship one feature, no settings UI, no
user toggles. Output: a transcript DSL with word-level timestamps precise
enough for quality edits by text.

## Why now

- The current `@xenova/transformers` pipeline loads `Xenova/whisper-tiny` (39 M
  params) into a Web Worker under `file://`, forcing ORT-WASM single-threaded.
  Result: ~0.5× realtime, the weakest Whisper model, fragile bundling
  (`vite.config.ts:33–41` ships hand-written stubs for `fs`, `path`, `url`,
  `onnxruntime-node`).
- The "edit video by editing the transcript" feature claims accuracy. Whisper's
  token-grouped `-ml 1` / `return_timestamps: "word"` timestamps drift
  ±50–200 ms per word. For "select the word 'um', delete it, clip shaves that
  exact duration" the drift becomes a visible bug. Forced alignment is
  required.
- Axcut (the reference) uses `faster-whisper` + `large-v3` default. We're
  picking `medium` to fit the average user computer.

## Constraints (locked)

- One feature. One PR (or atomic PR set shipped together). No phases.
- No settings UI. No model-size, alignment, language, or GPU toggles.
- Multilingual across all 13 OpenScreen locales.
- Word-level timestamps accurate enough for quality edits.
- Fits an average user computer: ~16 GB RAM, integrated GPU or mid-range
  discrete.
- Local inference. No cloud. No upload.

## Tech stack (locked)

| Concern        | Choice                                                                                |
| -------------- | ------------------------------------------------------------------------------------- |
| Recognizer     | `whisper.cpp v1.9.1` `whisper-server` HTTP, model `ggml-medium.bin` (~1.5 GB)         |
| GPU            | Auto-detect at startup; Metal+Core ML (Apple Silicon), CUDA (NVIDIA), Vulkan (AMD/Intel), CPU fallback |
| Word alignment | `onnxruntime-node` + `facebook/mms-alignment` (~1 GB, Apache-2.0, multilingual)       |
| IPC transport  | Long-lived `whisper-server` HTTP, single instance per app, requests queue             |
| Audio pipeline | `extractMono16kFromVideoUrl` (renderer, unchanged) → IPC → temp WAV → `whisper-server -f file` → aligner → response |

### Why `medium` over `large-v3`

`large-v3` is 3.1 GB, ~2× slower than `medium`, only ~5 % WER better on
English and marginally better on multilingual. The marginal user who notices
flips a toggle — but we ship no toggles, and `large-v3` violates the
average-compute constraint on Intel i5 / 16 GB laptops.

### Why `mms-alignment` over English-only `wav2vec2-base-960h`

`mms-alignment` is multilingual (covers all 13 OpenScreen locales),
Apache-2.0. `wav2vec2-base-960h` is English-only (~360 MB) and would force a
fallback path for non-English content that produces worse word timestamps than
English. Since alignment runs always-on and the recognizer is multilingual,
the aligner must be multilingual too.

### Verification needed during implementation

`facebook/mms-alignment` identity and ONNX-export availability on
`onnxruntime-node` needs verification in the first PR before committing the
1 GB bundle. Fallbacks if it doesn't work cleanly:

1. `facebook/wav2vec2-base-960h` (~360 MB, English only) + degraded
   phrase-level alignment for non-English.
2. Hand-rolled CTC forced aligner on top of `wav2vec2` ONNX weights.

## Architecture

```
video URL
   │
   ▼
extractMono16kFromVideoUrl  (renderer, unchanged)
   │  Float32Array
   ▼
ipcRenderer.invoke('stt:transcribe', {samples, language?})
   │
   ▼ (preload → main)
electron/stt/index.ts
   │
   ▼
electron/stt/whisperServer.ts ── spawn whisper-server (one per app, queue)
   │                              └─ ggml-medium.bin (downloaded on first use)
   │  phrase segments
   ▼
electron/stt/forcedAlignment.ts ── onnxruntime-node + facebook/mms-alignment
   │                                (downloaded on first use, always runs)
   │  word-level segments
   ▼
ipc response { segments, wordSegments, detectedLanguage, backend }
   │
   ▼
renderer worker resolves → annotationsFromCaptions.ts renders word-aligned lines
```

## File changes

### Add

- `electron/stt/whisperServer.ts` — `whisper-server` lifecycle, port
  allocation, HTTP client, queue supervisor.
- `electron/stt/forcedAlignment.ts` — ORT session, mms-alignment forward pass,
  per-word `[startSec, endSec]`.
- `electron/stt/modelManager.ts` — first-run download (Whisper + alignment
  model), SHA-256 verify, cache under `userData/stt-models/`, progress events.
- `electron/stt/gpuDetector.ts` — picks binary variant at startup; probes
  `nvidia-smi`, `system_profiler`, Vulkan init.
- `electron/stt/transcriptionContract.ts` — shared TS types.
- `electron/stt/index.ts` — IPC entry, wires the three pieces.
- `scripts/build-whisper-binaries.sh` — CMake matrix per platform-arch.
- `.github/workflows/build-whisper-binaries.yml` — CI matrix for binary
  variants.
- `tests/unit/electron/stt/{whisperServer,forcedAlignment,modelManager,gpuDetector}.test.ts`.

### Modify

- `vite.config.ts` — remove the four Vite aliases (lines 33–41).
- `package.json` — remove `@xenova/transformers`, `onnxruntime-web`,
  `onnxruntime-node`, `onnx-proto`, `onnxruntime-common`. Add real
  `onnxruntime-node`.
- `electron/main.ts` — register `stt:transcribe` handler; supervise
  `whisper-server` lifecycle.
- `electron/preload.ts` — expose `electronAPI.stt.transcribe(...)`.
- `electron-builder.yml` — `extraResources: [electron/native/bin/**]`.
- `src/lib/captioning/transcribe.worker.ts` — rewrite as thin IPC adapter.
- `src/lib/ai-edition/document/transcribe.ts:1-7` — update the adapter comment.

### Delete

- `src/lib/captioning/transcribeCore.ts`.
- `src/lib/vite-stubs/empty-node-module.ts`.
- `src/lib/vite-stubs/onnxruntime-node-stub.ts`.

## Bundle impact

| Asset                                              | Size              | Delivery                |
| -------------------------------------------------- | ----------------- | ----------------------- |
| `whisper-server` binaries (6 platform-arch combos) | ~5–25 MB each     | Bundled in installer    |
| `ggml-medium.bin`                                  | 1.5 GB            | First-transcription DL  |
| `facebook/mms-alignment` ONNX                      | ~1 GB             | First-transcription DL  |

First-run download total: ~2.5 GB. Progress shown in the existing
`onStatus("model")` channel (`transcribe.ts:88`). Cached permanently under
`userData/stt-models/`.

## Acceptance gate

- 5-minute multilingual clip on M1 CPU → ≤ 30 s end-to-end (Whisper + alignment).
- 5-minute multilingual clip on Intel i5/i7 (12th gen+) → ≤ 100 s end-to-end.
- Word-level timestamps within ±50 ms of ground truth on a 10-clip
  multilingual benchmark (en/fr/es/de).
- WER within 1 % of Axcut's `medium` on the same benchmark.
- Bundle delta: +5–25 MB binaries, 0 MB models until first use.
- Memory peak during transcription: ≤ 3.5 GB (medium 2.1 GB + mms-alignment
  ~1 GB + Electron baseline). Documented 16 GB RAM recommendation.

## Risks

- **`mms-alignment` ONNX availability.** Unverified. Verify in PR 1 before
  committing the bundle. Fallbacks documented above.
- **8 GB RAM laptops.** ~3.5 GB peak is tight. Document 16 GB recommendation;
  revisit only if real users on 8 GB hardware report OOM.
- **Apple Silicon first-run Core ML compile** adds 5–15 s one-time per
  machine. Folded into the model-load progress.
- **GPU CI matrix.** CPU CI covers correctness; GPU CI is smoke tests on
  self-hosted runners.

## Out of scope (locked out)

- Settings UI of any kind. Read-only backend status caption in transcript UI.
- Live in-recording captions. Batch transcription only.
- Speaker diarization.
- Cloud STT.