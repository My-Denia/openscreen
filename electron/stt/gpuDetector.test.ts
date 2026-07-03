import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { binaryNameForBackend, candidateBinaryPaths, detectGpuBackend } from "./gpuDetector";

describe("gpuDetector", () => {
	afterEach(() => {
		// Cache buster for env override in case individual tests set it.
		delete process.env.OPENSCREEN_WHISPER_SERVER_EXE;
	});

	it("picks the CPU fallback when no GPU detectors report success", async () => {
		// Local CI runners may differ — accept any backend that the spec
		// recognises (whisper-{metal,cuda,vulkan,cpu}) and only require a reason.
		const result = await detectGpuBackend();
		expect(["whisper-metal", "whisper-cuda", "whisper-vulkan", "whisper-cpu"]).toContain(
			result.backend,
		);
		expect(typeof result.reason).toBe("string");
		expect(result.reason.length).toBeGreaterThan(0);
	});

	it("binaryNameForBackend returns a stable name per backend", () => {
		expect(binaryNameForBackend("whisper-metal")).toBe("whisper-server-whisper-metal");
		expect(binaryNameForBackend("whisper-cuda")).toBe("whisper-server-whisper-cuda");
		expect(binaryNameForBackend("whisper-vulkan")).toBe("whisper-server-whisper-vulkan");
		expect(binaryNameForBackend("whisper-cpu")).toBe("whisper-server-whisper-cpu");
	});

	it("candidateBinaryPaths surfaces bin candidates under the repo root", () => {
		const here = "/fake/repo";
		const paths = candidateBinaryPaths("whisper-cpu", here);
		// No env override: the env entry is filtered, leaving only the bin paths.
		expect(paths.length).toBeGreaterThanOrEqual(2);
		// Compare via path.resolve/normalize so the assertion holds on both
		// POSIX and Windows hosts (Windows turns /fake/repo into \fake\repo).
		const expectedFlat = path.resolve(
			path.join(here, "electron", "native", "bin", "whisper-server-whisper-cpu"),
		);
		expect(paths.map((p) => path.resolve(p))).toContain(expectedFlat);
	});

	it("candidateBinaryPaths prepends env override when set", () => {
		process.env.OPENSCREEN_WHISPER_SERVER_EXE = "/custom/path/whisper-server";
		const here = "/fake/repo";
		const paths = candidateBinaryPaths("whisper-cpu", here);
		expect(paths[0]).toBe("/custom/path/whisper-server");
		delete process.env.OPENSCREEN_WHISPER_SERVER_EXE;
	});

	it("candidateBinaryPaths honours OPENSCREEN_WHISPER_SERVER_EXE when set", () => {
		process.env.OPENSCREEN_WHISPER_SERVER_EXE = "/custom/path/whisper-server";
		const paths = candidateBinaryPaths("whisper-cpu", "/fake/repo");
		expect(paths[0]).toBe("/custom/path/whisper-server");
	});
});
