import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetSttManagerForTests, SttManager } from "./index";
import type { SttStatusEvent, SttTranscribeResponse } from "./transcriptionContract";

// We swap the long-lived modules for fakes so the manager's `init()` and
// `transcribe()` paths can be exercised without spawning real processes or
// loading a 1 GB ONNX session.
const fakeForcedAligner = {
	ready: vi.fn(async () => undefined),
	align: vi.fn(async () => [] as Awaited<ReturnType<typeof fakeForcedAligner.align>>),
	dispose: vi.fn(async () => undefined),
};

const fakeWhisperServer = {
	start: vi.fn(),
	status: {
		backend: "whisper-cpu" as const,
		port: 9000,
		running: true,
		startedAtMs: 1,
		pid: 1,
		lastError: null,
	},
	transcribe: vi.fn(),
	stop: vi.fn(),
};

vi.mock("./whisperServer", () => {
	class FakeWhisperServerManager {
		start = fakeWhisperServer.start;
		status = fakeWhisperServer.status;
		transcribe = fakeWhisperServer.transcribe;
		stop = fakeWhisperServer.stop;
	}
	return { WhisperServerManager: FakeWhisperServerManager };
});

vi.mock("./forcedAlignment", () => {
	class FakeForcedAligner {
		ready = fakeForcedAligner.ready;
		align = fakeForcedAligner.align;
		dispose = fakeForcedAligner.dispose;
	}
	return { ForcedAligner: FakeForcedAligner };
});

vi.mock("./modelManager", () => ({
	ensureModels: vi.fn(async () => undefined),
	modelPaths: (base: string) => ({
		whisper: `${base}/whisper/ggml-medium.bin`,
		"mms-alignment": `${base}/mms-alignment/model.onnx`,
	}),
}));

vi.mock("./gpuDetector", () => ({
	detectGpuBackend: vi.fn(async () => ({ backend: "whisper-cpu", reason: "fake → cpu" })),
	binaryNameForBackend: (b: string) => `whisper-server-${b}`,
	candidateBinaryPaths: () => [] as string[],
	resolveBinaryPath: vi.fn(async () => ({
		path: "/fake/whisper",
		backend: "whisper-cpu" as const,
	})),
}));

describe("SttManager", () => {
	beforeEach(() => {
		fakeForcedAligner.ready.mockClear();
		fakeForcedAligner.align.mockClear();
		fakeForcedAligner.dispose.mockClear();
		fakeWhisperServer.start.mockClear();
		fakeWhisperServer.transcribe.mockClear();
		fakeWhisperServer.stop.mockClear();
		fakeWhisperServer.start.mockResolvedValue({ port: 9000, backend: "whisper-cpu" });
		fakeWhisperServer.transcribe.mockResolvedValue({
			segments: [{ text: "hello", startSec: 0, endSec: 0.5 }],
			detectedLanguage: "en",
		});
		fakeForcedAligner.align.mockResolvedValue([{ word: "hello", startSec: 0, endSec: 0.5 }]);
		fakeForcedAligner.dispose.mockResolvedValue(undefined);
		_resetSttManagerForTests();
	});

	afterEach(() => {
		_resetSttManagerForTests();
	});

	it("init() forwards model + transcribe phases to the sink", async () => {
		const sink = vi.fn<(e: SttStatusEvent) => void>();
		const mgr = new SttManager();
		// Skip the app.getPath call by providing an override at init time.
		await mgr.init({ statusSink: sink, modelsBaseDir: "/tmp/fake-stt-models" });
		const phases = sink.mock.calls.map(([event]) => event.phase);
		expect(phases[0]).toBe("model");
		expect(phases).toContain("transcribe");
	});

	it("transcribe() chains whisper → alignment and merges the result", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result: SttTranscribeResponse = await mgr.transcribe({
			samples: new Float32Array(16000),
			language: "en",
		});
		expect(result.detectedLanguage).toBe("en");
		expect(result.backend).toBe("whisper-cpu");
		expect(result.wordSegments).toHaveLength(1);
		expect(fakeWhisperServer.transcribe).toHaveBeenCalledOnce();
		expect(fakeForcedAligner.align).toHaveBeenCalledWith(
			expect.objectContaining({ sampleRate: 16_000 }),
		);
	});

	it("transcribe() falls back to phrase segments when forced alignment throws", async () => {
		fakeForcedAligner.align.mockRejectedValueOnce(new Error("ort session dropped"));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		const result = await mgr.transcribe({ samples: new Float32Array(16000) });
		expect(result.segments.length).toBeGreaterThan(0);
		expect(result.wordSegments).toEqual([]);
		consoleError.mockRestore();
	});

	it("shutdown() disposes the aligner and stops whisper-server", async () => {
		const mgr = new SttManager();
		await mgr.init({ modelsBaseDir: "/tmp/fake-stt-models" });
		await mgr.shutdown();
		expect(fakeForcedAligner.dispose).toHaveBeenCalledOnce();
		expect(fakeWhisperServer.stop).toHaveBeenCalledOnce();
	});

	it("setStatusSink replaces the previous sink (last call wins)", () => {
		const mgr = new SttManager();
		const a = vi.fn();
		const b = vi.fn();
		mgr.setStatusSink(a);
		mgr.setStatusSink(b);
		expect(mgr.getStatusSink()).toBe(b);
	});
});
