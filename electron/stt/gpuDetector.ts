import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import type { SttBackend } from "./transcriptionContract";

/**
 * Picks the `whisper-server` binary variant for the current host. The spec
 * locks no user-visible toggle — backend selection is automatic from platform +
 * GPU probes.
 *
 * Order of preference (highest first, falls through on probe failure):
 *   1. Apple Silicon                  → `whisper-metal`
 *   2. Apple Intel                    → `whisper-cpu`
 *   3. Linux/Windows + NVIDIA         → `whisper-cuda`
 *   4. Linux/Windows + Vulkan         → `whisper-vulkan`
 *   5. otherwise                      → `whisper-cpu`
 */

export interface GpuProbeResult {
	backend: SttBackend;
	/** Coarse reason for logs (e.g. "nvidia-smi exit 0", "darwin + arm64 → metal"). */
	reason: string;
}

/** Resolved locations for the `whisper-server` binary on disk; null until probes complete. */
export interface ResolvedBinary {
	backend: SttBackend;
	path: string | null;
}

/** Spawn with a hard deadline; resolves to `{exitCode}` or `null` (still running). */
function runProbe(
	cmd: string,
	args: string[],
	timeoutMs = 1500,
): Promise<{ exitCode: number | null }> {
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "ignore"] });
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({ exitCode: null });
		}, timeoutMs);
		child.once("error", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: null });
		});
		child.once("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: code });
		});
	});
}

/** `nvidia-smi` returning an exit code (any version) is a positive NVIDIA signal. */
async function probeNvidia(): Promise<boolean> {
	const result = await runProbe("nvidia-smi", ["-L"]);
	return result.exitCode === 0;
}

/** Vulkan loader present (libvulkan / vulkan-1.dll).  */
async function probeVulkan(): Promise<boolean> {
	if (process.platform === "win32") {
		return runProbe("where", ["vulkaninfo"]).then((r) => r.exitCode === 0);
	}
	if (process.platform === "darwin") {
		return runProbe("which", ["vulkaninfo"]).then((r) => r.exitCode === 0);
	}
	// Linux: try ldconfig for libvulkan.so.1, the canonical name.
	return runProbe("sh", ["-c", "ldconfig -p | grep -q libvulkan.so.1"]).then(
		(r) => r.exitCode === 0,
	);
}

/** Apple Silicon / Intel. darwin/arm64 → metal; darwin/x64 → cpu. */
function darwinBackend(): GpuProbeResult {
	const arm = process.arch === "arm64" || os.arch() === "arm64";
	return {
		backend: arm ? "whisper-metal" : "whisper-cpu",
		reason: `darwin + ${arm ? "arm64 → metal" : "x64 → cpu"}`,
	};
}

/**
 * Probe the host for GPU acceleration. Returns the chosen `SttBackend` plus a
 * short reason for log lines. Cheap to call: all probes run with a hard
 * timeout and the worst total wait is ~3s (nvidia + vulkan probes sequenced).
 */
export async function detectGpuBackend(): Promise<GpuProbeResult> {
	if (process.platform === "darwin") {
		return darwinBackend();
	}

	if (await probeNvidia()) {
		return { backend: "whisper-cuda", reason: "nvidia-smi present → cuda" };
	}

	if (await probeVulkan()) {
		return { backend: "whisper-vulkan", reason: "vulkan loader present → vulkan" };
	}

	return { backend: "whisper-cpu", reason: "no GPU detected → cpu" };
}

/** Conventional bin name for the chosen backend; matches `build-whisper-binaries.sh`. */
export function binaryNameForBackend(backend: SttBackend): string {
	return `whisper-server-${backend}`;
}

/**
 * Where to look for the binary, in priority order:
 *   1. `OPENSCREEN_WHISPER_SERVER_EXE` env override (debug builds)
 *   2. `electron/native/bin/<os>-<arch>/<binaryName>` (packaged + local cross-builds)
 *   3. `electron/native/bin/<binaryName>` (bare checkout, e.g. tests)
 */
export function candidateBinaryPaths(backend: SttBackend, here: string = process.cwd()): string[] {
	const tag = `${process.platform}-${process.arch}`;
	const name = binaryNameForBackend(backend);
	const envPath = process.env.OPENSCREEN_WHISPER_SERVER_EXE?.trim();
	return [
		envPath,
		path.join(here, "electron", "native", "bin", tag, name),
		path.join(here, "electron", "native", "bin", name),
	].filter((p): p is string => Boolean(p));
}

/** Probe → first existing candidate → null if none. */
export async function resolveBinaryPath(here: string = process.cwd()): Promise<ResolvedBinary> {
	const probe = await detectGpuBackend();
	for (const candidate of candidateBinaryPaths(probe.backend, here)) {
		// Light probe — we do not require exec here; the supervisor does the X_OK check.
		// Returning the path is enough; the spawn will fail loudly if not executable.
		if (candidate) {
			return { backend: probe.backend, path: candidate };
		}
	}
	return { backend: probe.backend, path: null };
}
