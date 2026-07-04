// End-to-end STT pipeline smoke test for wav2vec2-base-960h alignment.
// Runs in plain Node — uses the same wav2vec2 model the IPC handler would load.
// Confirms the actual ONNX inference works on this Node + ORT version.
//
// Run: node scripts/e2e-align-smoke.mjs

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import ort from "onnxruntime-node";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const MODEL_BUNDLED = join(
	ROOT,
	"electron",
	"native",
	"models",
	"wav2vec2-base-960h",
	"model.onnx",
);
const VOCAB_BUNDLED = join(
	ROOT,
	"electron",
	"native",
	"models",
	"wav2vec2-base-960h",
	"vocab.json",
);
const WAV_PATH = join(tmpdir(), "openscreen-stt-e2e", "audio.wav");

const EXPECTED_SHA = "8a278b42db089ddbc955152646575d439b31cca547cead37891f57c374451b36";
const TOKEN_PAD = 0;
const TOKEN_WORD_DELIMITER = 4;

function sha256(buf) {
	return createHash("sha256").update(buf).digest("hex");
}

function readWavMono16k(path) {
	const buf = readFileSync(path);
	if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
		throw new Error("not a WAV file");
	}
	const numChannels = buf.readUInt16LE(22);
	const sampleRate = buf.readUInt32LE(24);
	const bitsPerSample = buf.readUInt16LE(34);
	if (numChannels !== 1 || sampleRate !== 16000 || bitsPerSample !== 16) {
		throw new Error(`unexpected WAV format: ${numChannels}ch ${sampleRate}Hz ${bitsPerSample}b`);
	}
	const dataOffset = buf.toString("ascii", 36, 40) === "data" ? 44 : 46;
	const samples = new Float32Array((buf.length - dataOffset) / 2);
	for (let i = 0; i < samples.length; i++) {
		samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32_768;
	}
	return samples;
}

async function main() {
	const actual = sha256(readFileSync(MODEL_BUNDLED));
	console.log(`model.onnx SHA: ${actual}`);
	if (actual !== EXPECTED_SHA) {
		throw new Error(`SHA mismatch — expected ${EXPECTED_SHA}`);
	}
	const vocab = JSON.parse(readFileSync(VOCAB_BUNDLED, "utf8"));
	const idToToken = new Map(Object.entries(vocab).map(([k, v]) => [v, k]));
	console.log(`vocab_size: ${vocab.size ?? Object.keys(vocab).length}`);

	console.log("Loading ONNX session...");
	const session = await ort.InferenceSession.create(MODEL_BUNDLED, {
		executionProviders: ["cpu", "cpuExecutionProvider"],
		graphOptimizationLevel: "all",
	});

	console.log("Reading WAV...");
	const samples = readWavMono16k(WAV_PATH);
	console.log(`Audio: ${samples.length} samples (${(samples.length / 16000).toFixed(2)}s)`);

	console.log("Running forward pass...");
	const t0 = Date.now();
	const inputTensor = new ort.Tensor("float32", samples, [1, samples.length]);
	const result = await session.run({ input_values: inputTensor });
	const logits = result.logits ?? result[Object.keys(result)[0]];
	const dims = logits.dims;
	const time = dims[1];
	const vocabSize = dims[2];
	console.log(`logits shape: ${JSON.stringify(dims)} (${Date.now() - t0}ms)`);

	const tokenIds = new Array(time);
	for (let t = 0; t < time; t++) {
		let bestId = 0;
		let bestVal = logits.data[t * vocabSize];
		for (let v = 1; v < vocabSize; v++) {
			const val = logits.data[t * vocabSize + v];
			if (val > bestVal) {
				bestVal = val;
				bestId = v;
			}
		}
		tokenIds[t] = bestId;
	}
	console.log(`first 60 token ids: ${tokenIds.slice(0, 60).join(",")}`);
	console.log(
		`first 60 chars:    ${tokenIds
			.slice(0, 60)
			.map((id) => idToToken.get(id) ?? "?")
			.join("")}`,
	);

	const segments = [];
	let wordBuf = [];
	let wordStart = null;
	for (let i = 0; i < tokenIds.length; i++) {
		const tid = tokenIds[i];
		const sec = i / 50;
		if (tid === TOKEN_PAD) continue;
		if (tid === TOKEN_WORD_DELIMITER) {
			if (wordBuf.length > 0) {
				segments.push({ startSec: wordStart, endSec: sec, text: wordBuf.join("") });
			}
			wordBuf = [];
			wordStart = null;
			continue;
		}
		const tok = idToToken.get(tid);
		if (tok === undefined) continue;
		if (wordStart === null) wordStart = sec;
		wordBuf.push(tok);
	}
	if (wordBuf.length > 0 && wordStart !== null) {
		segments.push({ startSec: wordStart, endSec: tokenIds.length / 50, text: wordBuf.join("") });
	}

	console.log(`\n${segments.length} word segments:`);
	for (const seg of segments) {
		console.log(
			`  [${seg.startSec.toFixed(2)}-${seg.endSec.toFixed(2)}] ${JSON.stringify(seg.text)}`,
		);
	}
	console.log("\nAlignment smoke test passed.");
}

main().catch((err) => {
	console.error("FAILED:", err);
	process.exit(1);
});
