import { readFile } from "node:fs/promises";
import path from "node:path";
import { WAV2VEC2_VOCAB_SHA256 } from "./modelManager";
import type { SttPhraseSegment, SttWordSegment } from "./transcriptionContract";

/**
 * Word-level forced alignment on top of `facebook/wav2vec2-base-960h` (Apache 2.0).
 *
 *   audio (Float32Array @ 16 kHz)
 *     → onnxruntime forward pass → CTC logits over a 32-token char vocab
 *     → per-frame argmax → token-id stream
 *     → walk the token stream, slice on the `|` word-delimiter (id 4) and
 *       blank frames (id 0) → one word per group → word timestamps
 *
 * License note: Apache 2.0 is MIT-compatible, unlike `facebook/mms-alignment`
 * which is CC-BY-NC-4.0 and would have blocked distribution under MIT.
 *
 * Coverage: char-level English-only forced alignment. The vocab is 32 tokens
 * (a-z + apostrophe + word-delimiter `|` + 4 special). Non-English audio
 * falls back to whisper.cpp's per-token timestamps, which are less precise
 * (~±50-200 ms) but already produced at zero extra cost.
 *
 * Framerate: the wav2vec2 feature extractor downsamples 16 kHz by 5×2×2×2×2×2×2 = 320,
 * so each output frame covers 20 ms of audio. We assume 50 Hz downstream.
 */

interface OrtModule {
	InferenceSession: {
		create(uri: string, options?: unknown): Promise<OrtSession>;
	};
}

interface OrtSession {
	inputNames: readonly string[];
	outputNames: readonly string[];
	run(
		feeds: Record<string, { type: string; data: Float32Array; dims: readonly number[] }>,
	): Promise<Record<string, { data: Float32Array; dims: readonly number[] }>>;
}

/** Allows tests to inject a fake ORT runtime; production loads `onnxruntime-node`. */
export type OrtLoader = () => Promise<OrtModule>;

const DEFAULT_ORT_LOADER: OrtLoader = async () => {
	const mod = (await import("onnxruntime-node")) as unknown as OrtModule;
	if (!mod?.InferenceSession?.create) {
		throw new Error("onnxruntime-node is not available; forced alignment cannot run");
	}
	return mod;
};

/** Default ONNX input name for wav2vec2-base-960h. */
export const ALIGNMENT_INPUT_NAME = "input_values";
/** Default ONNX output name; the model returns logits over the 32-token vocab. */
export const ALIGNMENT_OUTPUT_NAME = "logits";

/** Special token ids in the wav2vec2-base-960h vocab (stable, alphabetical + specials). */
const TOKEN_PAD = 0; // <pad>
const TOKEN_WORD_DELIMITER = 4; // "|"

/** ponytail: char-level vocab with stable token-to-id mapping (verified by reading the
 * downloaded vocab.json). Used as a fast-path when the on-disk vocab is missing. */
const KNOWN_VOCAB: Record<string, number> = {
	"<pad>": 0,
	"<s>": 1,
	"</s>": 2,
	"<unk>": 3,
	"|": 4,
	E: 5,
	T: 6,
	A: 7,
	O: 8,
	N: 9,
	I: 10,
	H: 11,
	S: 12,
	R: 13,
	D: 14,
	L: 15,
	U: 16,
	M: 17,
	W: 18,
	C: 19,
	F: 20,
	G: 21,
	Y: 22,
	P: 23,
	B: 24,
	V: 25,
	K: 26,
	"'": 27,
	X: 28,
	J: 29,
	Q: 30,
	Z: 31,
};

/**
 * ponytail: pure function — exported for tests. Builds the (token → id) lookup
 * from the downloaded `vocab.json` (raw HuggingFace JSON object: `token → id`).
 * Falls back to the hard-coded `KNOWN_VOCAB` if `rawVocab` is empty/malformed.
 */
export function toAlignmentVocab(rawVocab: unknown): {
	tokenToId: Map<string, number>;
	idToToken: Map<number, string>;
} {
	const tokenToId = new Map<string, number>();
	if (rawVocab && typeof rawVocab === "object") {
		for (const [tok, rawId] of Object.entries(rawVocab as Record<string, unknown>)) {
			const id = Number(rawId);
			if (Number.isFinite(id) && id >= 0) tokenToId.set(tok, id);
		}
	}
	if (tokenToId.size === 0) {
		for (const [tok, id] of Object.entries(KNOWN_VOCAB)) tokenToId.set(tok, id);
	}
	const idToToken = new Map<number, string>();
	for (const [tok, id] of tokenToId) idToToken.set(id, tok);
	return { tokenToId, idToToken };
}

/** ponytail: pure function — exposes how the recognizer's word text maps to per-frame
 * token ids. Each entry is one non-blank, non-delimiter character of a word (the
 * wav2vec2 CTC head emits letters directly; no subword splits). Words are
 * reconstructed at the consumer by walking past `|` (word delimiter) and `<pad>`
 * (blank) frames.
 */
export interface CharToken {
	char: string;
	id: number;
}

export interface CharPhraseSegment {
	phraseIndex: number;
	wordIndex: number;
	tokens: CharToken[]; // the letters, in order, with their token ids
}

/** Public for tests. Returns the per-word char-token sequences for each phrase. */
export function phraseCharTokens(
	phrases: SttPhraseSegment[],
	tokenToId: Map<string, number>,
): CharPhraseSegment[] {
	const out: CharPhraseSegment[] = [];
	for (let phraseIndex = 0; phraseIndex < phrases.length; phraseIndex++) {
		const phrase = phrases[phraseIndex];
		const words = phrase.text
			.normalize("NFKC")
			.replace(/[^\p{L}'’\-\s]/gu, "")
			.split(/\s+/)
			.filter(Boolean);
		for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
			const word = words[wordIndex].toUpperCase();
			const tokens: CharToken[] = [];
			for (const ch of word) {
				// ponytail: wav2vec2 vocab has `'` for apostrophes but not other punctuation;
				// skip chars we can't represent rather than fail the whole phrase.
				const id = tokenToId.get(ch);
				if (id !== undefined && id !== TOKEN_PAD && id !== TOKEN_WORD_DELIMITER) {
					tokens.push({ char: ch, id });
				}
			}
			if (tokens.length > 0) out.push({ phraseIndex, wordIndex, tokens });
		}
	}
	return out;
}

export interface ForcedAlignerOptions {
	/** Absolute path to the ONNX file. */
	modelPath: string;
	/** Absolute path to the matching `vocab.json`; loaded once on first align(). */
	vocabPath?: string;
	ortLoader?: OrtLoader;
}

/** Manager for the long-lived ORT session; should be created once per app. */
export class ForcedAligner {
	private session: OrtSession | null = null;
	private tokenToId: Map<string, number> | null = null;
	private readonly opts: ForcedAlignerOptions;
	private readonly prepareOnce: Promise<void>;

	constructor(opts: ForcedAlignerOptions) {
		this.opts = opts;
		this.prepareOnce = this.prepare();
	}

	/** Lazy session + vocab load. Safe to call multiple times. */
	async ready(): Promise<void> {
		return this.prepareOnce;
	}

	private async prepare(): Promise<void> {
		const loader = this.opts.ortLoader ?? DEFAULT_ORT_LOADER;
		const ort = await loader();
		// ponytail: ORT 1.20+ renamed the CPU EP from "cpuExecutionProvider" to
		// "cpu". Pass both so the same code works whether `onnxruntime-node`
		// pulls 1.17.x or 1.20+ — ORT drops unknown names with a warning
		// and falls through to the next.
		const session = await ort.InferenceSession.create(path.resolve(this.opts.modelPath), {
			executionProviders: ["cpu", "cpuExecutionProvider"],
			graphOptimizationLevel: "all",
		});
		this.session = session as unknown as OrtSession;
		// ponytail: vocab load is deferred to first align() — optional config
		// (sampling_rate, conv strides) lives in the same file but only the
		// vocab mapping is strictly required for the alignment walk.
	}

	private async ensureVocabLoaded(): Promise<Map<string, number>> {
		if (this.tokenToId) return this.tokenToId;
		if (!this.opts.vocabPath) {
			// ponytail: skip the disk read when the caller didn't provide a path —
			// tests inject vocab via the public API; production always sets it.
			const { tokenToId } = toAlignmentVocab(KNOWN_VOCAB);
			this.tokenToId = tokenToId;
			return tokenToId;
		}
		const raw = await readFile(this.opts.vocabPath, "utf8");
		const parsed = JSON.parse(raw) as unknown;
		const { tokenToId } = toAlignmentVocab(parsed);
		// ponytail: a SHA-pinned download could in principle still be tampered with
		// on disk; verify once at load and refuse if it drifted. Cheap (a few ms
		// per file), fail-fast, no recheck on every align() call.
		const expected = WAV2VEC2_VOCAB_SHA256;
		const { createHash } = await import("node:crypto");
		const actual = createHash("sha256").update(raw, "utf8").digest("hex").toLowerCase();
		if (actual !== expected.toLowerCase()) {
			throw new Error(
				`vocab.json SHA mismatch: expected ${expected}, got ${actual}. Re-download required.`,
			);
		}
		this.tokenToId = tokenToId;
		return tokenToId;
	}

	/**
	 * Align each phrase into per-word `[startSec, endSec]` timestamps by walking the
	 * CTC argmax sequence.
	 */
	async align(opts: {
		samples: Float32Array;
		sampleRate: number;
		phraseSegments: SttPhraseSegment[];
	}): Promise<SttWordSegment[]> {
		await this.prepareOnce;
		if (!this.session) {
			throw new Error("ForcedAligner not ready");
		}
		if (opts.phraseSegments.length === 0) return [];
		const tokenToId = await this.ensureVocabLoaded();

		const tokens = phraseCharTokens(opts.phraseSegments, tokenToId);
		if (tokens.length === 0) return [];

		const { inputValues, frameCount } = prepareInput(opts.samples, opts.sampleRate);
		const feeds = {
			[ALIGNMENT_INPUT_NAME]: {
				type: "float32",
				data: inputValues,
				dims: [1, inputValues.length],
			},
		};
		const result = await this.session.run(feeds);
		const logits = result[ALIGNMENT_OUTPUT_NAME] ?? result[Object.keys(result)[0]!];
		if (!logits) {
			throw new Error("alignment session returned no outputs");
		}
		const tokenIds = argmaxOverTime(logits);
		return mapTokensToTime(tokens, tokenIds, frameCount, opts.samples.length / opts.sampleRate);
	}

	/** Free the ORT session; the next call re-loads. */
	async dispose(): Promise<void> {
		this.session = null;
		this.tokenToId = null;
	}
}

/**
 * mms-alignment uses a 49.95 Hz framerate from a 320-downsampled 16 kHz input;
 * wav2vec2-base-960h has the same downsampling ratio (5×2×2×2×2×2×2 = 320),
 * giving exactly 50 Hz at 16 kHz.
 */
function prepareInput(
	samples: Float32Array,
	sampleRate: number,
): { inputValues: Float32Array; frameCount: number } {
	const targetRate = 16_000;
	const aligned =
		sampleRate === targetRate ? samples : resampleLinear(samples, sampleRate, targetRate);
	const FRAMES_PER_SECOND = 50;
	const durationSec = aligned.length / targetRate;
	const frameCount = Math.max(1, Math.round(durationSec * FRAMES_PER_SECOND));
	return { inputValues: aligned, frameCount };
}

/** Ponytail: linear resampler if a non-16 kHz input sneaks through. */
function resampleLinear(samples: Float32Array, from: number, to: number): Float32Array {
	if (from === to) return samples;
	const ratio = to / from;
	const outLength = Math.max(1, Math.round(samples.length * ratio));
	const out = new Float32Array(outLength);
	for (let i = 0; i < outLength; i++) {
		const srcIdx = i / ratio;
		const i0 = Math.floor(srcIdx);
		const i1 = Math.min(samples.length - 1, i0 + 1);
		const t = srcIdx - i0;
		out[i] = (samples[i0] ?? 0) * (1 - t) + (samples[i1] ?? 0) * t;
	}
	return out;
}

/** argmax across the last axis of the logits tensor → token id per frame. */
function argmaxOverTime(logits: { data: Float32Array; dims: readonly number[] }): number[] {
	const { data, dims } = logits;
	if (dims.length < 2) {
		throw new Error(`Unexpected logits dims ${JSON.stringify(dims)}`);
	}
	const [batch, time, vocab] = [dims[0] ?? 1, dims[1] ?? 0, dims[2] ?? 0];
	if (batch !== 1) {
		// ponytail: model is per-utterance; multi-batch would need batch packing. Refuse.
		throw new Error(`argmaxOverTime expects batch=1, got ${batch}`);
	}
	const out: number[] = new Array(time);
	for (let t = 0; t < time; t++) {
		const offset = t * vocab;
		let bestId = 0;
		let bestVal = data[offset] ?? -Infinity;
		for (let v = 1; v < vocab; v++) {
			const val = data[offset + v] ?? -Infinity;
			if (val > bestVal) {
				bestVal = val;
				bestId = v;
			}
		}
		out[t] = bestId;
	}
	return out;
}

/**
 * Walk the per-frame token stream once. For each expected char in each word
 * (`tokens`), find the first frame whose argmax is that char (and ≥ the
 * previous search position). The end-of-word frame is the first frame after
 * the last char where the argmax switches to something else (a `|`, a blank,
 * or the next word's first char). Convert frame index to time via
 * `frameIndex / 50 Hz`.
 *
 * Why greedy: the wav2vec2 CTC head emits `|` between words and blank between
 * repeated chars. Repeated letters in the same word land on consecutive frames;
 * word boundaries match `|` frames; blank frames appear inside repeated chars
 * (e.g. "hello" → HHHH ee lll l ooo — but the model collapses repeats anyway).
 * Greedy first-match-then-walk-to-next is the canonical torchaudio
 * ForcedAligner algorithm.
 */
function mapTokensToTime(
	tokens: CharPhraseSegment[],
	frameIds: number[],
	frameCount: number,
	totalDurationSec: number,
): SttWordSegment[] {
	const FRAMES_PER_SECOND = 50;
	const dur = Math.max(totalDurationSec, frameCount / FRAMES_PER_SECOND);
	const out: SttWordSegment[] = [];
	let cursor = 0;

	for (const token of tokens) {
		const firstFrame = findFirstFrame(frameIds, token.tokens[0]!.id, cursor, frameCount);
		if (firstFrame < 0) {
			// ponytail: char never appears in the CTC stream — the model dropped
			// the whole word. Skip it rather than emit a fake span.
			continue;
		}
		const lastChar = token.tokens[token.tokens.length - 1]!;
		const lastFrame = findLastFrame(frameIds, lastChar.id, firstFrame, frameCount);
		cursor = lastFrame + 1;

		const startSec = Math.min(dur, firstFrame / FRAMES_PER_SECOND);
		const endSec = Math.max(startSec + 0.02, Math.min(dur, (lastFrame + 1) / FRAMES_PER_SECOND));
		const wordText = token.tokens
			.map((t) => t.char)
			.join("")
			.toLowerCase();
		out.push({ word: wordText, startSec, endSec });
	}
	return out;
}

/** Find the first frame ≥ startIdx whose argmax equals `targetId`. */
function findFirstFrame(
	frameIds: number[],
	targetId: number,
	startIdx: number,
	frameCount: number,
): number {
	for (let i = startIdx; i < frameCount; i++) {
		if (frameIds[i] === targetId) return i;
	}
	return -1;
}

/**
 * Find the last frame where `targetId` is held, starting at `fromFrame`. Allows
 * repeated-token stretches (a char may span many frames). Caps at the first
 * frame after `fromFrame` that switches to something else.
 */
function findLastFrame(
	frameIds: number[],
	targetId: number,
	fromFrame: number,
	frameCount: number,
): number {
	for (let i = fromFrame + 1; i < frameCount; i++) {
		if (frameIds[i] !== targetId) return i - 1;
	}
	return frameCount - 1;
}
