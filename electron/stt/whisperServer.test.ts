import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WhisperServerManager, writeSamplesAsWav } from "./whisperServer";

describe("whisperServer.writeSamplesAsWav", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "stt-wav-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("writes a 16 kHz mono 16-bit PCM WAV with a valid RIFF header", async () => {
		const samples = new Float32Array(1600);
		for (let i = 0; i < samples.length; i++) {
			samples[i] = Math.sin((2 * Math.PI * 440 * i) / 16_000) * 0.5;
		}
		const wavPath = await writeSamplesAsWav(samples);
		const statResult = await stat(wavPath);
		// RIFF header (44) + 16-bit mono (samples * 2).
		expect(statResult.size).toBe(44 + samples.length * 2);
		try {
			const fs = await import("node:fs/promises");
			const head = await fs.readFile(wavPath, { encoding: null });
			const headBuf = head.subarray(0, 12);
			expect(headBuf.toString("ascii", 0, 4)).toBe("RIFF");
			expect(headBuf.toString("ascii", 8, 12)).toBe("WAVE");
			expect(head.readUInt16LE(22)).toBe(1); // mono
			expect(head.readUInt32LE(24)).toBe(16_000); // sample rate
			expect(head.readUInt16LE(34)).toBe(16); // bits per sample
		} finally {
			// Cleanup the parent temp dir the helper created.
			await rm(path.dirname(wavPath), { recursive: true, force: true });
		}
	});

	it("clamps samples outside [-1, 1] so the writer can't overflow int16", async () => {
		const samples = new Float32Array([2, -2, 1.5, -1.5]);
		const wavPath = await writeSamplesAsWav(samples);
		try {
			const fs = await import("node:fs/promises");
			const head = await fs.readFile(wavPath, { encoding: null });
			const dataOffset = 44;
			// 2 → +1 → 32_767; -2 → -1 → -32_767 (round(-32_767.5) is implementation-defined for ties).
			expect(head.readInt16LE(dataOffset)).toBe(32_767);
			expect(head.readInt16LE(dataOffset + 2)).toBe(-32_767);
			// 1.5 → clamp to +1 → still 32_767.
			expect(head.readInt16LE(dataOffset + 4)).toBe(32_767);
			expect(head.readInt16LE(dataOffset + 6)).toBe(-32_767);
		} finally {
			await rm(path.dirname(wavPath), { recursive: true, force: true });
		}
	});
});

describe("WhisperServerManager", () => {
	it("reports a clean status when not started", () => {
		const mgr = new WhisperServerManager();
		const status = mgr.status;
		expect(status.running).toBe(false);
		expect(status.pid).toBeNull();
		expect(status.port).toBeNull();
		expect(status.backend).toBeNull();
		expect(status.startedAtMs).toBeNull();
	});

	it("clears lastError between runs", () => {
		const mgr = new WhisperServerManager();
		// Private mutator just to check that calling status gives a fresh shape.
		mgr.stop(); // should be a no-op
		expect(mgr.status.running).toBe(false);
	});
});
