"""End-to-end forced-alignment smoke test for wav2vec2-base-960h.

Loads the ONNX model + vocab via onnxruntime (Python) on the same audio as
e2e-stt-smoke.mjs's WAV, prints the CTC argmax stream and a word-aligned
transcript reconstructed from the char-level logits.

Run: python scripts/e2e-align-smoke.py
"""

import hashlib
import json
import struct
import sys
import wave
from pathlib import Path

import numpy as np
import onnxruntime as ort

SCRIPT_DIR = Path(__file__).resolve().parent
ROOT = SCRIPT_DIR.parent
MODEL = ROOT / "electron" / "native" / "models" / "wav2vec2-base-960h" / "model.onnx"
VOCAB = ROOT / "electron" / "native" / "models" / "wav2vec2-base-960h" / "vocab.json"
WAV_PATH = Path(
    f"{__import__('os').environ.get('TEMP', '/tmp')}/openscreen-stt-e2e/audio.wav"
)
# Default to Windows temp path.
if not WAV_PATH.exists():
    WAV_PATH = Path(
        f"{__import__('os').environ.get('APPDATA')}/Local/Temp/openscreen-stt-e2e/audio.wav"
    )

EXPECTED_SHA = "8a278b42db089ddbc955152646575d439b31cca547cead37891f57c374451b36"
TOKEN_PAD = 0
TOKEN_WORD_DELIMITER = 4


def main() -> int:
    actual = hashlib.sha256(MODEL.read_bytes()).hexdigest()
    print(f"model.onnx SHA: {actual}")
    if actual != EXPECTED_SHA:
        print(f"  MISMATCH — expected {EXPECTED_SHA}")
        return 1

    with open(VOCAB, encoding="utf-8") as f:
        vocab = json.load(f)
    id_to_token = {v: k for k, v in vocab.items()}
    print(f"vocab_size: {len(vocab)} (expected 32)")

    print("Loading ONNX session...")
    sess = ort.InferenceSession(str(MODEL), providers=["CPUExecutionProvider"])

    with wave.open(str(WAV_PATH), "rb") as w:
        assert w.getnchannels() == 1, "expected mono"
        assert w.getframerate() == 16000, "expected 16 kHz"
        assert w.getsampwidth() == 2, "expected 16-bit"
        nframes = w.getnframes()
        raw = w.readframes(nframes)
    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    duration_sec = len(samples) / 16000
    frame_count = int(round(duration_sec * 50))
    print(f"Audio: {len(samples)} samples ({duration_sec:.2f}s, expected {frame_count} frames)")

    print("Running forward pass...")
    logits = sess.run(None, {"input_values": samples.reshape(1, -1)})[0][0]  # (time, vocab)
    print(f"logits shape: {logits.shape}")

    token_ids = logits.argmax(axis=-1)
    print(f"first 60 token ids: {token_ids[:60].tolist()}")
    decoded = "".join(id_to_token.get(int(i), "?") for i in token_ids[:60])
    print(f"first 60 chars:    {decoded!r}")

    # Crude word segmentation: walk non-blank frames, split on word delimiter `|`.
    segments = []
    word = []
    word_start = None
    for i, tid in enumerate(token_ids):
        sec = i / 50
        if tid == TOKEN_PAD:
            continue
        if tid == TOKEN_WORD_DELIMITER:
            if word:
                segments.append((word_start, sec, "".join(word)))
            word = []
            word_start = None
            continue
        tok = id_to_token.get(int(tid))
        if tok is None:
            continue
        if word_start is None:
            word_start = sec
        word.append(tok)
    if word:
        segments.append((word_start, token_ids.size / 50, "".join(word)))

    print(f"\n{len(segments)} word segments:")
    for start, end, text in segments:
        print(f"  [{start:.2f}-{end:.2f}] {text!r}")
    print("\nAlignment smoke test passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())