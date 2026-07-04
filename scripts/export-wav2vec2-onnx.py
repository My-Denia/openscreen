#!/usr/bin/env python
"""
Export facebook/wav2vec2-base-960h (Apache 2.0, MIT-compatible) to ONNX so it
can be loaded by onnxruntime-node.

Why this script exists:
  - facebook/wav2vec2-base-960h ships on HuggingFace as PyTorch only
    (model.safetensors / pytorch_model.bin). There is no pre-exported ONNX
    file at onnx/model.onnx.
  - We bundle the exported ONNX alongside the app at
    electron/native/models/wav2vec2-base-960h/ so the runtime can SHA-verify
    it locally instead of downloading from a non-existent HF URL.
  - This script regenerates the bundle. Run once locally, commit the .onnx
    alongside, and bump the SHA-256 pin in electron/stt/modelManager.ts.

Usage:
  pip install "optimum[onnxruntime]" transformers
  python scripts/export-wav2vec2-onnx.py
"""

import os
import sys
from pathlib import Path

REPO = "facebook/wav2vec2-base-960h"
SCRIPT_DIR = Path(__file__).resolve().parent
OUT_DIR = SCRIPT_DIR.parent / "electron" / "native" / "models" / "wav2vec2-base-960h"


def main() -> int:
    os.environ.setdefault("HF_HOME", str(SCRIPT_DIR / ".cache" / "hf"))
    from optimum.exporters.onnx import main as onnx_export

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Exporting {REPO} → {OUT_DIR}")

    argv = [
        sys.argv[0],
        "--model",
        REPO,
        "--task",
        "automatic-speech-recognition",
        "--framework",
        "pt",
        "--opset",
        "17",
        "--output",
        str(OUT_DIR),
        "--cache_dir",
        os.environ["HF_HOME"],
    ]
    try:
        onnx_export(argv)
    except SystemExit as e:
        if e.code not in (0, None):
            print(f"optimum-cli export exited with code {e.code}")
            return int(e.code)
    print("Done. Files:")
    for f in sorted(OUT_DIR.iterdir()):
        print(f"  {f.name}  ({f.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    sys.exit(main())