import { type ChildProcessByStdio, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	access,
	constants as fsConstants,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";

import { resolveBinaryPath } from "./gpuDetector";
import type { SttBackend, SttPhraseSegment } from "./transcriptionContract";

/** whisper-server takes no stdin and writes to stdout+stderr — match Node's return type. */
type WhisperChild = ChildProcessByStdio<null, Readable, Readable>;

/**
 * Owns the long-lived `whisper-server` process used to recognize speech.
 *
 * Lifecycle:
 *   1. `start()` resolves the binary on disk via `gpuDetector.resolveBinaryPath`.
 *   2. Allocates a free localhost port, spawns `whisper-server -m <model> --port <p>`.
 *   3. Polls the server's HTTP root until 200 (whisper-server answers `GET /`).
 *   4. `transcribe(samples)` writes a temporary WAV and POSTs to `/inference`.
 *
 * Concurrency: simple single-flight queue — the second call awaits the first.
 * whisper-server handles one inference at a time anyway; serializing avoids
 * two transcriptions stepping on each other's uploads.
 */

export interface WhisperServerStartOptions {
	/** Absolute path to the ggml model file (medium.bin by default). */
	modelPath: string;
	/** Externally-resolved binary path (skips gpuDetector on startup); null = auto. */
	binaryPath?: string | null;
	/** Externally-resolved backend (logs only); null = auto. */
	backend?: SttBackend | null;
}

export interface WhisperServerStatus {
	running: boolean;
	pid: number | null;
	port: number | null;
	backend: SttBackend | null;
	startedAtMs: number | null;
	lastError: string | null;
}

/** Phrase segment as emitted by whisper-server's `/inference` JSON response. */
interface WhisperJsonSegment {
	timestamps?: { from?: string | number; to?: string | number };
	text?: string;
}

interface WhisperJsonResponse {
	transcription?: WhisperJsonSegment[];
	language?: string;
	detected_language?: string;
	result?: { language?: string };
}

export class WhisperServerManager {
	private process: WhisperChild | null = null;
	private port: number | null = null;
	private backend: SttBackend | null = null;
	private lastError: string | null = null;
	private startedAtMs: number | null = null;
	private inFlight: Promise<unknown> = Promise.resolve();

	/** Used for buffered stderr from the helper; surfaced on shutdown + poll failures. */
	private stderrTail = "";
	private readonly stderrTailMax = 64 * 1024;

	/** Allocate a free TCP port on the loopback interface; resolves to the picked port. */
	private static async pickFreePort(): Promise<number> {
		return new Promise((resolve, reject) => {
			const server = createServer();
			server.unref();
			server.on("error", reject);
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address();
				if (!addr || typeof addr === "string") {
					server.close();
					reject(new Error("Could not allocate port"));
					return;
				}
				const port = addr.port;
				server.close(() => resolve(port));
			});
		});
	}

	/** Check the server's HTTP root for a 200; resolves once responsive. */
	private static async pollUntilReady(baseUrl: string, timeoutMs = 30_000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		// 250ms pacing keeps the round-trip overhead under 1s while polling out to 30s.
		while (Date.now() < deadline) {
			try {
				const res = await fetch(baseUrl, { method: "GET" });
				if (res.ok) return;
			} catch {
				// not up yet
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
		throw new Error(`whisper-server at ${baseUrl} did not respond within ${timeoutMs}ms`);
	}

	private recordError(message: string): void {
		this.lastError = message;
	}

	/** True when a process is alive and a model is loaded. */
	get status(): WhisperServerStatus {
		return {
			running: this.process !== null && this.port !== null,
			pid: this.process?.pid ?? null,
			port: this.port,
			backend: this.backend,
			startedAtMs: this.startedAtMs,
			lastError: this.lastError,
		};
	}

	/**
	 * Spawn the helper if not running and return once `/` returns 200. Idempotent —
	 * if a server is already up we just return its port so the caller never pays
	 * the cold-start cost twice.
	 */
	async start(options: WhisperServerStartOptions): Promise<{ port: number; backend: SttBackend }> {
		if (this.process && this.port) {
			return { port: this.port, backend: this.backend ?? options.backend ?? "whisper-cpu" };
		}

		const resolved = options.binaryPath
			? { path: options.binaryPath, backend: options.backend ?? "whisper-cpu" }
			: await resolveBinaryPath();
		if (!resolved.path) {
			const message =
				"whisper-server binary not found; build it via scripts/build-whisper-binaries.sh";
			this.recordError(message);
			throw new Error(message);
		}
		try {
			await access(resolved.path, fsConstants.X_OK);
		} catch {
			const message = `whisper-server binary at ${resolved.path} is not executable`;
			this.recordError(message);
			throw new Error(message);
		}
		if (!existsSync(options.modelPath)) {
			throw new Error(`Whisper model not found at ${options.modelPath}`);
		}

		const port = await WhisperServerManager.pickFreePort();
		const child = spawn(
			resolved.path,
			[
				"-m",
				options.modelPath,
				"--port",
				String(port),
				// Host defaults to 127.0.0.1 in whisper-server; pin it explicitly so
				// future changes don't accidentally expose it on 0.0.0.0.
				"-h",
				"127.0.0.1",
				"--convert",
				"false",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);

		this.process = child;
		this.port = port;
		this.backend = resolved.backend;
		this.startedAtMs = Date.now();
		this.stderrTail = "";
		this.lastError = null;

		child.stderr.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			this.stderrTail = (this.stderrTail + text).slice(-this.stderrTailMax);
		});
		child.once("exit", (code) => {
			if (this.process === child) {
				const reason =
					code === null
						? "exited without code"
						: `exited with code ${code}; stderr=${this.stderrTail.slice(-512)}`;
				this.recordError(reason);
				this.process = null;
				this.port = null;
				this.startedAtMs = null;
			}
		});
		child.once("error", (err) => {
			this.recordError(`spawn error: ${err.message}`);
		});

		const baseUrl = `http://127.0.0.1:${port}`;
		try {
			await WhisperServerManager.pollUntilReady(baseUrl);
		} catch (err) {
			await this.stop();
			throw err instanceof Error ? err : new Error(String(err));
		}
		return { port, backend: resolved.backend };
	}

	/** Send SIGTERM and wait for the helper to exit. Resolves even if it was already down. */
	async stop(): Promise<void> {
		if (!this.process) {
			this.port = null;
			this.startedAtMs = null;
			return;
		}
		const child = this.process;
		this.process = null;
		this.port = null;
		this.startedAtMs = null;
		const exited = new Promise<void>((resolve) => {
			child.once("exit", () => resolve());
		});
		child.kill("SIGTERM");
		try {
			await Promise.race([
				exited,
				new Promise<void>((_, reject) => setTimeout(() => reject(new Error("timeout")), 5_000)),
			]);
		} catch {
			child.kill("SIGKILL");
		}
	}

	private baseUrl(): string {
		if (!this.port) throw new Error("whisper-server not started");
		return `http://127.0.0.1:${this.port}`;
	}

	private async ensureReady(): Promise<void> {
		if (!this.process || !this.port) {
			throw new Error("whisper-server not started; call start() first");
		}
	}

	private async runMultipartInfer(opts: {
		wavPath: string;
		language?: string;
	}): Promise<WhisperJsonResponse> {
		await this.ensureReady();
		const url = `${this.baseUrl()}/inference`;
		const form = new FormData();
		const fileBuffer = await readFile(opts.wavPath);
		const blob = new Blob([fileBuffer], { type: "audio/wav" });
		form.set("file", blob, path.basename(opts.wavPath));
		form.set("response_format", "json");
		if (opts.language) form.set("language", opts.language);
		const res = await fetch(url, { method: "POST", body: form });
		if (!res.ok) {
			const text = await res.text().catch(() => "");
			throw new Error(`whisper-server /inference HTTP ${res.status}: ${text.slice(0, 512)}`);
		}
		return (await res.json()) as WhisperJsonResponse;
	}

	/** One segment's `from`/`to` come from whisper-server as floats-in-strings ("0.000"). */
	private toSec(value: string | number | undefined, fallback: number): number {
		if (value === undefined) return fallback;
		const n = typeof value === "string" ? Number(value) : value;
		return Number.isFinite(n) ? n : fallback;
	}

	/** Run one transcription; serializes concurrent callers. */
	async transcribe(opts: { samples: Float32Array; language?: string }): Promise<{
		segments: SttPhraseSegment[];
		detectedLanguage: string;
	}> {
		const task = this.inFlight.then(() => this.transcribeImpl(opts));
		// swallow rejection so the chain stays alive; callers await via `task` directly
		this.inFlight = task.catch(() => undefined);
		return task;
	}

	private async transcribeImpl(opts: { samples: Float32Array; language?: string }): Promise<{
		segments: SttPhraseSegment[];
		detectedLanguage: string;
	}> {
		const wavPath = await writeSamplesAsWav(opts.samples);
		try {
			const json = await this.runMultipartInfer({ wavPath, language: opts.language });
			const raw = json.transcription ?? [];
			const segments: SttPhraseSegment[] = raw
				.map((seg) => {
					const text = (seg.text ?? "").trim();
					const startSec = this.toSec(seg.timestamps?.from, 0);
					const endSec = this.toSec(seg.timestamps?.to, startSec + 0.5);
					return { text, startSec, endSec: Math.max(endSec, startSec + 0.05) };
				})
				.filter((s) => s.text.length > 0);
			const detectedLanguage =
				json.detected_language ?? json.language ?? json.result?.language ?? "auto";
			return { segments, detectedLanguage };
		} finally {
			await cleanupWav(wavPath);
		}
	}
}

/** Writes a 16-bit PCM mono 16 kHz WAV file and returns its path. */
export async function writeSamplesAsWav(samples: Float32Array): Promise<string> {
	const sampleRate = 16_000;
	const numChannels = 1;
	const bitsPerSample = 16;
	const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
	const blockAlign = numChannels * (bitsPerSample / 8);
	const dataLength = samples.length * (bitsPerSample / 8);
	const fileLength = 44 + dataLength;

	const buf = Buffer.alloc(44 + dataLength);
	buf.write("RIFF", 0);
	buf.writeUInt32LE(fileLength - 8, 4);
	buf.write("WAVE", 8);
	buf.write("fmt ", 12);
	buf.writeUInt32LE(16, 16);
	buf.writeUInt16LE(1, 20);
	buf.writeUInt16LE(numChannels, 22);
	buf.writeUInt32LE(sampleRate, 24);
	buf.writeUInt32LE(byteRate, 28);
	buf.writeUInt16LE(blockAlign, 32);
	buf.writeUInt16LE(bitsPerSample, 34);
	buf.write("data", 36);
	buf.writeUInt32LE(dataLength, 40);
	// 16-bit PCM conversion with hard clipping so a malformed input can't clip the writer.
	for (let i = 0; i < samples.length; i++) {
		const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
		buf.writeInt16LE(Math.round(s * 32_767), 44 + i * 2);
	}

	const tmpDir = await mkdtemp(path.join(os.tmpdir(), "openscreen-stt-"));
	const outPath = path.join(tmpDir, "audio.wav");
	await writeFile(outPath, buf);
	return outPath;
}

/** Remove a wav file plus the directory `writeSamplesAsWav` created for it. */
export async function cleanupWav(wavPath: string): Promise<void> {
	const dir = path.dirname(wavPath);
	await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}
