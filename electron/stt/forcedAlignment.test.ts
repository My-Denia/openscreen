import { describe, expect, it } from "vitest";

import {
	ALIGNMENT_INPUT_NAME,
	ALIGNMENT_OUTPUT_NAME,
	phraseCharTokens,
	toAlignmentVocab,
} from "./forcedAlignment";
import type { SttPhraseSegment } from "./transcriptionContract";

/**
 * The renderer-side `forcedAlignment.ts` is a char-level CTC aligner on top of
 * facebook/wav2vec2-base-960h (Apache 2.0). These tests lock in the public
 * vocabulary + phrase-token-walk contract. ORT session loading is exercised
 * separately by integration-style flows (a real .onnx is required).
 */

const REAL_VOCAB = {
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

describe("forcedAlignment.vocab", () => {
	it("toAlignmentVocab builds a token→id map from the HF vocab.json shape", () => {
		const v = toAlignmentVocab(REAL_VOCAB);
		expect(v.tokenToId.size).toBe(32);
		expect(v.tokenToId.get("|")).toBe(4);
		expect(v.tokenToId.get("A")).toBe(7);
		expect(v.tokenToId.get("'")).toBe(27);
		expect(v.idToToken.get(0)).toBe("<pad>");
	});

	it("toAlignmentVocab falls back to KNOWN_VOCAB when input is empty", () => {
		const v = toAlignmentVocab({});
		// Empty input → built from KNOWN_VOCAB constant.
		expect(v.tokenToId.get("|")).toBe(4);
	});

	it("toAlignmentVocab ignores entries with non-numeric ids", () => {
		const v = toAlignmentVocab({ A: "seven", E: 5, B: NaN });
		expect(v.tokenToId.get("E")).toBe(5);
		expect(v.tokenToId.get("A")).toBeUndefined();
		expect(v.tokenToId.get("B")).toBeUndefined();
	});
});

describe("forcedAlignment.phraseCharTokens", () => {
	const { tokenToId } = toAlignmentVocab(REAL_VOCAB);

	it("splits text into per-word char tokens, uppercased", () => {
		const phrases: SttPhraseSegment[] = [{ text: "hello world", startSec: 0, endSec: 0.6 }];
		const tokens = phraseCharTokens(phrases, tokenToId);
		expect(tokens).toHaveLength(2);
		expect(tokens[0]?.phraseIndex).toBe(0);
		expect(tokens[0]?.wordIndex).toBe(0);
		expect(tokens[0]?.tokens.map((t) => t.char)).toEqual(["H", "E", "L", "L", "O"]);
		expect(tokens[1]?.tokens.map((t) => t.char)).toEqual(["W", "O", "R", "L", "D"]);
	});

	it("uppercases to match wav2vec2's all-caps vocab", () => {
		const tokens = phraseCharTokens([{ text: "Hello", startSec: 0, endSec: 0.3 }], tokenToId);
		expect(tokens[0]?.tokens.map((t) => t.char)).toEqual(["H", "E", "L", "L", "O"]);
	});

	it("preserves apostrophes (id 27 in the vocab)", () => {
		const tokens = phraseCharTokens([{ text: "don't go", startSec: 0, endSec: 0.4 }], tokenToId);
		expect(tokens[0]?.tokens.map((t) => t.char)).toEqual(["D", "O", "N", "'", "T"]);
	});

	it("drops chars not in the vocab rather than failing", () => {
		// "café" has 'é' which isn't in wav2vec2's English alphabet.
		const tokens = phraseCharTokens([{ text: "café", startSec: 0, endSec: 0.4 }], tokenToId);
		expect(tokens[0]?.tokens.map((t) => t.char)).toEqual(["C", "A", "F"]);
	});

	it("drops the word entirely if no chars remain after filtering", () => {
		// "你好" is all CJK — no chars in the English vocab.
		const tokens = phraseCharTokens([{ text: "你好 world", startSec: 0, endSec: 0.4 }], tokenToId);
		expect(tokens).toHaveLength(1);
		expect(tokens[0]?.tokens.map((t) => t.char)).toEqual(["W", "O", "R", "L", "D"]);
	});

	it("skips the `|` (word delimiter) and `<pad>` ids when present in the vocab", () => {
		// Defensive: even if someone puts these in the input text, they should
		// never be emitted as word chars. Our normalizer strips them first, but
		// the assertion is here to lock the behavior if the normalizer changes.
		const phrases: SttPhraseSegment[] = [{ text: "hi | there", startSec: 0, endSec: 0.4 }];
		const tokens = phraseCharTokens(phrases, tokenToId);
		// `|` is normalized away by the `replace(/[^\p{L}'’\-\s]/gu, "")` call.
		expect(tokens.map((t) => t.tokens.map((c) => c.char).join(""))).toEqual(["HI", "THERE"]);
	});

	it("handles multi-phrase input with stable phraseIndex/wordIndex", () => {
		const phrases: SttPhraseSegment[] = [
			{ text: "hello", startSec: 0, endSec: 0.3 },
			{ text: "world peace", startSec: 0.4, endSec: 0.9 },
		];
		const tokens = phraseCharTokens(phrases, tokenToId);
		expect(tokens).toHaveLength(3);
		expect(tokens.map((t) => t.phraseIndex)).toEqual([0, 1, 1]);
		expect(tokens.map((t) => t.wordIndex)).toEqual([0, 0, 1]);
	});
});

describe("forcedAlignment.constants", () => {
	it("ALIGNMENT_INPUT_NAME matches the wav2vec2 ONNX export", () => {
		expect(ALIGNMENT_INPUT_NAME).toBe("input_values");
	});

	it("ALIGNMENT_OUTPUT_NAME matches the wav2vec2 ONNX export", () => {
		expect(ALIGNMENT_OUTPUT_NAME).toBe("logits");
	});
});
