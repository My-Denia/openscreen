import { describe, expect, it } from "vitest";

import {
	ALIGNMENT_INPUT_NAME,
	ALIGNMENT_OUTPUT_NAME,
	phraseTokens,
	toAlignmentTokenizer,
} from "./forcedAlignment";
import type { SttPhraseSegment } from "./transcriptionContract";

describe("forcedAlignment.token vocabulary", () => {
	it("toAlignmentTokenizer maps token <-> id bidirectionally", () => {
		const t = toAlignmentTokenizer({
			tokenizerConfig: {},
			vocab: { hello: 1, world: 2, "▁foo": 3 },
		});
		expect(t.tokenToId.get("hello")).toBe(1);
		expect(t.tokenToId.get("world")).toBe(2);
		expect(t.tokenToId.get("▁foo")).toBe(3);
		expect(t.idToToken.get(1)).toBe("hello");
		expect(t.idToToken.get(2)).toBe("world");
		expect(t.idToToken.get(3)).toBe("▁foo");
		expect(t.vocabSize).toBe(3);
	});

	it("phraseTokens expands whitespace and inserts blanks between phrases", () => {
		const tokenToId = new Map<string, number>([
			["▁hello", 1],
			["▁world", 2],
		]);
		const phrases: SttPhraseSegment[] = [
			{ text: "hello world", startSec: 0, endSec: 1 },
			{ text: "world hello", startSec: 1, endSec: 2 },
		];
		const tokens = phraseTokens(phrases, tokenToId);
		// 4 word tokens + 2 blanks (one after each phrase) = 6.
		expect(tokens).toHaveLength(6);
		expect(tokens[0]).toMatchObject({ tokenId: 1, word: "hello" });
		expect(tokens[1]).toMatchObject({ tokenId: 2, word: "world" });
		expect(tokens[2]).toMatchObject({ tokenId: 0, word: "" });
		// Second phrase begins at tokens[3], ends with a blank at tokens[5].
		expect(tokens[3]).toMatchObject({ tokenId: 2, word: "world" });
		expect(tokens[4]).toMatchObject({ tokenId: 1, word: "hello" });
		expect(tokens[5]).toMatchObject({ tokenId: 0, word: "" });
	});

	it("phraseTokens strips punctuation when finding a token id", () => {
		const tokenToId = new Map<string, number>([["▁hello", 1]]);
		const tokens = phraseTokens([{ text: "Hello, world!", startSec: 0, endSec: 1 }], tokenToId);
		expect(tokens[0]?.tokenId).toBe(1);
	});

	it("phraseTokens drops words not in the vocab (forces an OOV-tolerant pipeline)", () => {
		const tokenToId = new Map<string, number>([["▁hello", 1]]);
		const tokens = phraseTokens([{ text: "hello unknown", startSec: 0, endSec: 1 }], tokenToId);
		// 1 word token + 1 trailing blank = 2.
		expect(tokens).toHaveLength(2);
		expect(tokens[0]?.word).toBe("hello");
		expect(tokens[1]).toMatchObject({ tokenId: 0, word: "" });
	});

	it("ALIGNMENT input/output names match mms-alignment's contract", () => {
		expect(ALIGNMENT_INPUT_NAME).toBe("input_values");
		expect(ALIGNMENT_OUTPUT_NAME).toBe("logits");
	});
});
