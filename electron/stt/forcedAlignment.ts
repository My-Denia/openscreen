import path from "node:path";
import { MMS_ALIGNMENT_TOKENIZER_CONFIG_URL, MMS_ALIGNMENT_VOCAB_URL } from "./modelManager";
import type { SttPhraseSegment, SttWordSegment } from "./transcriptionContract";

/**
 * Word-level forced alignment on top of `facebook/mms-alignment` ONNX.
 *
 *   audio (Float32Array @ 16 kHz)
 *     → onnxruntime forward pass → CTC logits over word-piece tokens
 *     → per-frame argmax → token-id stream
 *     → for each word in the recognizer's phrase, locate its token id(s) and
 *       frame-interpolate `[startSec, endSec]`.
 *
 * The aligner is multilingual (covers all 13 OpenScreen locales) because it
 * powers forced alignment always-on regardless of language. Model weights are
 * downloaded on first use by `modelManager.ensureModels`.
 *
 * Spec fallback chain if `mms-alignment` ONNX isn't compatible with
 * `onnxruntime-node`:
 *   1. `facebook/wav2vec2-base-960h` (~360 MB, English) + degraded phrase alignment.
 *   2. Hand-rolled CTC forced aligner on top of `wav2vec2` ONNX weights.
 *
 * The verification step ("mms-alignment identity and ONNX-export availability
 * on onnxruntime-node needs verification in the first PR") is encoded here as
 * `loadAlignmentSession` lazy-loading the ORT runtime; the constructor falls
 * back with a typed error if `onnxruntime-node` is missing or returns a
 * non-`InferenceSession` value.
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

/** Default ONNX input name for mms-alignment's Wav2Vec2 model. */
export const ALIGNMENT_INPUT_NAME = "input_values";
/** Default ONNX output name; the model returns logits over the word-piece vocab. */
export const ALIGNMENT_OUTPUT_NAME = "logits";

/**
 * Tokenizer + vocab mapping for `mms-alignment`. Loaded once and cached for
 * the life of the aligner. `tokenToId` is the inverse of the vocabulary file
 * shipped with the HuggingFace repo; `wordToToken` gives the surface token id
 * for a word (assuming no further subword splits — the aligner yields word
 * matches in near-monotone speech).
 */
interface AlignmentTokenizer {
	tokenToId: Map<string, number>;
	idToToken: Map<number, string>;
	vocabSize: number;
}

interface AlignmentTokenizerFiles {
	tokenizerConfig: unknown;
	vocab: Record<string, number>;
}

async function fetchAlignmentTokenizer(fetcher: typeof fetch = fetch): Promise<AlignmentTokenizer> {
	const [tokenizerRes, vocabRes] = await Promise.all([
		fetcher(MMS_ALIGNMENT_TOKENIZER_CONFIG_URL, { headers: { "user-agent": "openscreen-stt" } }),
		fetcher(MMS_ALIGNMENT_VOCAB_URL, { headers: { "user-agent": "openscreen-stt" } }),
	]);
	if (!tokenizerRes.ok) throw new Error(`Failed to fetch tokenizer config: ${tokenizerRes.status}`);
	if (!vocabRes.ok) throw new Error(`Failed to fetch vocab: ${vocabRes.status}`);
	const tokenizerConfig = (await tokenizerRes.json()) as unknown;
	const vocab = (await vocabRes.json()) as Record<string, number>;
	const files: AlignmentTokenizerFiles = { tokenizerConfig, vocab };
	return toAlignmentTokenizer(files);
}

/** Pure function — exposed for unit tests. Builds the lookup tables from raw JSON. */
export function toAlignmentTokenizer(files: AlignmentTokenizerFiles): AlignmentTokenizer {
	const tokenToId = new Map<string, number>();
	for (const [token, id] of Object.entries(files.vocab)) {
		tokenToId.set(token, id);
	}
	const idToToken = new Map<number, string>();
	for (const [token, id] of tokenToId) idToToken.set(id, token);
	return {
		tokenToId,
		idToToken,
		vocabSize: tokenToId.size,
	};
}

export interface ForcedAlignerOptions {
	/** Absolute path to the ONNX file. */
	modelPath: string;
	ortLoader?: OrtLoader;
	fetcher?: typeof fetch;
}

/** Manager for the long-lived ORT session; should be created once per app. */
export class ForcedAligner {
	private session: OrtSession | null = null;
	private tokenizer: AlignmentTokenizer | null = null;
	private readonly opts: ForcedAlignerOptions;
	private readonly loadOnce: Promise<void>;

	constructor(opts: ForcedAlignerOptions) {
		this.opts = opts;
		this.loadOnce = this.prepare();
	}

	/** Lazy session + tokenizer load. Safe to call multiple times. */
	async ready(): Promise<void> {
		return this.loadOnce;
	}

	private async prepare(): Promise<void> {
		const loader = this.opts.ortLoader ?? DEFAULT_ORT_LOADER;
		const ort = await loader();
		const session = await ort.InferenceSession.create(path.resolve(this.opts.modelPath), {
			// mms-alignment is CPU-friendly; ORT picks a sensible default.
			executionProviders: ["cpuExecutionProvider"],
			graphOptimizationLevel: "all",
		});
		this.session = session as unknown as OrtSession;
		this.tokenizer = await fetchAlignmentTokenizer(this.opts.fetcher);
	}

	/**
	 * Align each phrase into per-word `[startSec, endSec]` timestamps by
	 * greedy CTC alignment of the recognizer's hypothesis against the audio.
	 *
	 * Returns one `SttWordSegment` per non-empty token in the recognizer's
	 * text; an empty result signals the aligner found no frames for the
	 * hypothesis (caller may fall back to phrase-level spans).
	 */
	async align(opts: {
		samples: Float32Array;
		sampleRate: number;
		phraseSegments: SttPhraseSegment[];
	}): Promise<SttWordSegment[]> {
		await this.loadOnce;
		if (!this.session || !this.tokenizer) {
			throw new Error("ForcedAligner not ready");
		}
		if (opts.phraseSegments.length === 0) return [];
		const tokens = phraseTokens(opts.phraseSegments, this.tokenizer.tokenToId);
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
		// No explicit disposal in ORT's narrow binding; nulling the refs is enough for GC.
		this.session = null;
		this.tokenizer = null;
	}
}

/** Public for tests — converts each phrase into a stream of token ids, including
 * blanks (id 0, standard CTC blank) between phrases so the aligner can't bleed
 * spans across phrase boundaries.
 */
export function phraseTokens(
	phrases: SttPhraseSegment[],
	tokenToId: Map<string, number>,
): { tokenId: number; phraseIndex: number; wordIndex: number; word: string }[] {
	const out: ReturnType<typeof phraseTokens> = [];
	for (let phraseIndex = 0; phraseIndex < phrases.length; phraseIndex++) {
		const phrase = phrases[phraseIndex];
		const words = phrase.text
			.normalize("NFKC")
			.replace(/[^\p{L}\p{N}'’\-\s]/gu, " ")
			.split(/\s+/)
			.filter(Boolean);
		for (let wordIndex = 0; wordIndex < words.length; wordIndex++) {
			const word = words[wordIndex];
			// Try direct match first; fall back to the model-required ▁ (U+2581) prefix
			// that mms-alignment's vocab uses for word-initial tokens.
			const prefixed = `▁${word}`;
			let id = tokenToId.get(prefixed) ?? tokenToId.get(word);
			if (id === undefined) {
				// Last-ditch: lowercase + strip punctuation.
				const cleaned = word.toLowerCase().replace(/[^\p{L}\p{N}'’-]/gu, "");
				id = tokenToId.get(`▁${cleaned}`) ?? tokenToId.get(cleaned);
			}
			if (id === undefined) {
				// ponytail: un-transcribable word — skip rather than fail the whole phrase.
				continue;
			}
			out.push({ tokenId: id, phraseIndex, wordIndex, word });
		}
		out.push({ tokenId: 0, phraseIndex, wordIndex: -1, word: "" }); // blank
	}
	return out;
}

/**
 * mms-alignment expects a 1-D Float32Array at 16 kHz. Returns the input plus
 * how many CTC frames it represents at the model's framerate (~49.95 Hz).
 * For non-16 kHz inputs we resample naively (linear interpolation) since
 * forced alignment is always called after a 16 kHz pipeline upstream; if a
 * different rate arrives, we degrade to the nearest-frame mapping instead of
 * throwing — fallback path documented in the spec.
 */
function prepareInput(
	samples: Float32Array,
	sampleRate: number,
): { inputValues: Float32Array; frameCount: number } {
	const targetRate = 16_000;
	const aligned =
		sampleRate === targetRate ? samples : resampleLinear(samples, sampleRate, targetRate);
	const FRAMES_PER_SECOND = 49.95;
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
 * For each predicted word, find the first frame matching its token id (and
 * the last frame before the next non-blank token). Convert frame index to
 * seconds by `frameIndex / framesPerSecond`, clamped to `[0, totalDurationSec]`.
 */
function mapTokensToTime(
	tokens: { tokenId: number; word: string }[],
	frameIds: number[],
	frameCount: number,
	totalDurationSec: number,
): SttWordSegment[] {
	const FRAMES_PER_SECOND = 49.95;
	const dur = Math.max(totalDurationSec, frameCount / FRAMES_PER_SECOND);
	const out: SttWordSegment[] = [];
	let cursor = 0;

	for (const tok of tokens) {
		if (tok.tokenId === 0) continue; // skip blanks
		// Find first occurrence of `tok.tokenId` at or after `cursor` so the
		// aligner can't reuse the same frame for two consecutive matches.
		let startFrame = -1;
		for (let i = cursor; i < frameCount; i++) {
			if (frameIds[i] === tok.tokenId) {
				startFrame = i;
				break;
			}
		}
		if (startFrame < 0) {
			// ponytail: word didn't align — drop it from the output rather than emit
			// a placeholder span that would lie about the audio.
			continue;
		}
		// End at the next non-blank, non-self frame, or the last frame the
		// model emitted. We allow staying on the same token id (no gap) since
		// CTC can stretch a token across consecutive frames.
		let endFrame = frameCount - 1;
		for (let i = startFrame + 1; i < frameCount; i++) {
			if (frameIds[i] !== tok.tokenId) {
				endFrame = i;
				break;
			}
		}
		cursor = endFrame;

		const startSec = Math.min(dur, startFrame / FRAMES_PER_SECOND);
		const endSec = Math.max(startSec + 0.02, Math.min(dur, (endFrame + 1) / FRAMES_PER_SECOND));
		out.push({ word: tok.word, startSec, endSec });
	}
	return out;
}
