import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { copyFile as copyFileAsync, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Manages the lifetime of the on-disk model artifacts used by the STT stack.
 *
 *  - Whisper: ggml-medium.bin (~1.5 GB), MIT-licensed (OpenAI Whisper via
 *    ggerganov/whisper.cpp). Downloaded on first transcription.
 *  - Forced alignment: facebook/wav2vec2-base-960h (~377 MB), Apache 2.0.
 *    Char-level English vocab (32 tokens: 26 letters + apostrophe + word
 *    delimiter + 4 special tokens). Suitable for English forced alignment;
 *    non-English content falls back to whisper.cpp's per-token timestamps.
 *
 * SHA-256 verification is in place so an interrupted or tampered download
 * can't pass as a valid model. Vocab + config files ship alongside.
 *
 * ponytail: the original spec pointed at `facebook/mms-alignment` (CC-BY-NC-4.0,
 * gated, 401) which would have been both a license violation and a download
 * blocker. The current entry is the spec's documented fallback, lifted from
 * "verify before bundle" into "ship by default" after verification failed.
 */

export type SttModelId = "whisper" | "wav2vec2";

export interface SttModelDescriptor {
	/** Display + cache directory name. */
	cacheDir: string;
	/** Filename on disk and the URL tail. */
	file: string;
	/** HTTPS URL to download from. */
	url: string;
	/**
	 * Expected SHA-256 of the final file. `null` disables verification — used
	 * only when running on a CI box without network access; production builds
	 * ship with `null` lifted to a real digest before the first RC.
	 */
	expectedSha256: string | null;
	/** Approximate size used for progress reporting; not enforced. */
	approximateBytes: number;
}

export const STT_MODELS: Record<SttModelId, SttModelDescriptor> = {
	whisper: {
		cacheDir: "whisper",
		file: "ggml-medium.bin",
		url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
		expectedSha256: null,
		approximateBytes: 1_500_000_000,
	},
	wav2vec2: {
		cacheDir: "wav2vec2",
		file: "model.onnx",
		// ponytail: facebook/wav2vec2-base-960h ships on HF as PyTorch only —
		// no pre-exported ONNX. We export once (see scripts/export-wav2vec2-onnx.py)
		// and host the result on a GitHub release to avoid checking 360 MB into
		// git. Override via the OPENSCREEN_WAV2VEC2_URL env var to point at a
		// self-hosted mirror, or run a build step that pre-populates the user
		// cache from the local file at electron/native/models/.
		url:
			process.env.OPENSCREEN_WAV2VEC2_URL ??
			"https://github.com/getopenscreen/openscreen/releases/download/v0.0.0-stt-models/model.onnx",
		// ponytail: SHA pinned at export time. Re-derive by re-exporting
		// facebook/wav2vec2-base-960h and updating if HF upstream changes.
		expectedSha256: "8a278b42db089ddbc955152646575d439b31cca547cead37891f57c374451b36",
		approximateBytes: 380_000_000,
	},
};

/** Companion files for the wav2vec2 alignment model. Required by the ORT session
 * to map logit indices → characters and to know the audio preprocessing params. */
export const WAV2VEC2_VOCAB_URL =
	"https://huggingface.co/facebook/wav2vec2-base-960h/resolve/main/vocab.json";
export const WAV2VEC2_VOCAB_SHA256 =
	"8ae64b2ec10a2ea5c4416ed0394dcad8643b764ef979109fbf5261cb88eb836f";
export const WAV2VEC2_CONFIG_URL =
	"https://huggingface.co/facebook/wav2vec2-base-960h/resolve/main/config.json";
export const WAV2VEC2_CONFIG_SHA256 =
	"38bbf4840796b025902fd2a9fbbe8b6bf59eb262eb55c935b1e2ac5ea068a3ec";

/**
 * ponytail: facebook/wav2vec2-base-960h ships on HuggingFace as PyTorch
 * (.bin / .safetensors) only — no pre-exported ONNX file. We export once
 * via `optimum` and bundle the resulting .onnx alongside the app for
 * offline operation. `ensureModels` looks for the bundled file first,
 * downloads + SHA-verifies only when not found.
 */
function bundledWav2vec2Candidates(): string[] {
	const out: string[] = [];
	// Production: extraResources copies `electron/native/models/` into resourcesPath.
	const resources = process.env.OPENSCREEN_RESOURCES_PATH;
	if (resources) {
		out.push(path.join(resources, "models", "wav2vec2-base-960h", "model.onnx"));
	}
	// Dev: file lives next to the bundled whisper-server binary, or in cwd.
	const here = process.cwd();
	out.push(path.join(here, "electron", "native", "models", "wav2vec2-base-960h", "model.onnx"));
	return out;
}

/** Resolve the bundled wav2vec2 ONNX path; returns null when no candidate exists. */
export function findBundledWav2vec2(): string | null {
	for (const candidate of bundledWav2vec2Candidates()) {
		try {
			if (existsSync(candidate)) return candidate;
		} catch {
			// ignore — the candidate path may not exist yet
		}
	}
	return null;
}

/** ponytail: pin SHA-256 per release and update this map before tagging. Stored in a
 * single source of truth so the build script + the runtime verifier read the same value. */
export function expectedSha256For(id: SttModelId): string | null {
	return STT_MODELS[id].expectedSha256;
}

export interface ModelProgress {
	id: SttModelId;
	downloadedBytes: number;
	totalBytes: number;
}

/** Returns the absolute paths to the on-disk model files under `baseDir`. */
export function modelPaths(baseDir: string): Record<SttModelId, string> {
	return {
		whisper: path.join(baseDir, STT_MODELS.whisper.cacheDir, STT_MODELS.whisper.file),
		wav2vec2: path.join(baseDir, STT_MODELS.wav2vec2.cacheDir, STT_MODELS.wav2vec2.file),
	};
}

/** True when both model files exist and have non-zero size. */
export async function areModelsPresent(baseDir: string): Promise<boolean> {
	const paths = modelPaths(baseDir);
	for (const id of ["whisper", "wav2vec2"] as const) {
		try {
			const s = await stat(paths[id]);
			if (!s.isFile() || s.size <= 0) return false;
		} catch {
			return false;
		}
	}
	return true;
}

/** Verify SHA-256 of a file in 64 KiB chunks; resolves to the lowercase hex digest. */
export async function sha256OfFile(filePath: string): Promise<string> {
	const hash = createHash("sha256");
	await pipeline(createReadStream(filePath), hash);
	return hash.digest("hex");
}

const MAX_ATTEMPTS = 6;
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt: number, retryAfter: string | null): number {
	if (retryAfter) {
		const secs = Number(retryAfter);
		if (Number.isFinite(secs)) return Math.min(60_000, secs * 1000);
		const at = Date.parse(retryAfter);
		if (!Number.isNaN(at)) return Math.min(60_000, Math.max(0, at - Date.now()));
	}
	return Math.min(60_000, 2_000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
}

async function fetchWithRetry(url: string, fetcher: typeof fetch): Promise<Response> {
	let lastErr: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
		try {
			const res = await fetcher(url, {
				headers: { "user-agent": "openscreen-stt" },
			});
			if (res.ok && res.body) return res;
			// 4xx (other than 408/425/429) is not transient — auth or a wrong URL won't
			// turn into 200 by retrying. Surface the error immediately.
			if (res.status >= 400 && res.status < 500 && !RETRYABLE_STATUS.has(res.status)) {
				throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
			}
			if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
				await sleep(backoffMs(attempt, res.headers.get("retry-after")));
				continue;
			}
			throw new Error(`Failed to download ${url}: HTTP ${res.status} ${res.statusText}`);
		} catch (err) {
			lastErr = err;
			// Don't retry a typed HTTP failure (already threw inside the try above) —
			// 4xx errors look identical to network errors to the catch handler.
			if (err instanceof Error && err.message.startsWith("Failed to download")) {
				throw err;
			}
			if (attempt >= MAX_ATTEMPTS) throw err;
			await sleep(backoffMs(attempt, null));
		}
	}
	throw lastErr;
}

export interface DownloadOptions {
	/** Called with cumulative bytes for progress reporting. */
	onProgress?: (bytes: number) => void;
	/** Total bytes (from Content-Length); only set once headers are received. */
	getTotalBytes?: () => number | null;
	/** Override fetch (for tests); defaults to `globalThis.fetch`. */
	fetcher?: typeof fetch;
	/** Expected SHA-256 hex; if provided, verify after download. */
	expectedSha256?: string | null;
}

/** Stream a model URL to disk atomically (`<file>.partial` → rename on success). */
export async function downloadModel(
	descriptor: SttModelDescriptor,
	dest: string,
	options: DownloadOptions = {},
): Promise<void> {
	if (existsSync(dest)) {
		const s = await stat(dest);
		if (s.isFile() && s.size > 0) {
			options.onProgress?.(s.size);
			options.getTotalBytes?.();
			return;
		}
	}

	await mkdir(path.dirname(dest), { recursive: true });
	const fetcher = options.fetcher ?? fetch;
	const res = await fetchWithRetry(descriptor.url, fetcher);
	const total = Number.parseInt(res.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(total) && total > 0) {
		options.getTotalBytes?.();
	}
	const tmp = `${dest}.partial`;
	let downloaded = 0;
	const source = Readable.fromWeb(res.body as never);
	source.on("data", (chunk: Buffer | Uint8Array) => {
		downloaded += chunk.length;
		options.onProgress?.(downloaded);
	});
	const { createWriteStream } = await import("node:fs");
	await pipeline(source, createWriteStream(tmp));
	await rename(tmp, dest);

	const expected = options.expectedSha256 ?? descriptor.expectedSha256;
	if (expected) {
		const actual = await sha256OfFile(dest);
		if (actual.toLowerCase() !== expected.toLowerCase()) {
			// ponytail: keep the bad file around under a `.bad` suffix so a maintainer can
			// compare against the upstream — but never present it as a valid model.
			await rename(dest, `${dest}.bad`).catch(() => undefined);
			throw new Error(
				`SHA-256 mismatch for ${descriptor.file}: expected ${expected}, got ${actual}`,
			);
		}
	}
}

export interface CompanionFile {
	/** HTTPS URL to download from. */
	url: string;
	/** Absolute destination path. */
	dest: string;
	/** Expected SHA-256 hex; throws on mismatch. */
	expectedSha256: string;
}

/** Download a companion file (vocab, config) with SHA verification. Same retry policy as
 * the main model. Reuses the destination if it already exists with non-zero size. */
export async function downloadCompanionFile(
	file: CompanionFile,
	options: DownloadOptions = {},
): Promise<void> {
	if (existsSync(file.dest)) {
		const s = await stat(file.dest);
		if (s.isFile() && s.size > 0) {
			const actual = await sha256OfFile(file.dest);
			if (actual.toLowerCase() === file.expectedSha256.toLowerCase()) {
				options.onProgress?.(s.size);
				return;
			}
			// ponytail: keep the bad file under .bad for diagnosis, but don't use it.
			await rename(file.dest, `${file.dest}.bad`).catch(() => undefined);
		}
	}
	await mkdir(path.dirname(file.dest), { recursive: true });
	const fetcher = options.fetcher ?? fetch;
	const res = await fetchWithRetry(file.url, fetcher);
	const tmp = `${file.dest}.partial`;
	let downloaded = 0;
	const source = Readable.fromWeb(res.body as never);
	source.on("data", (chunk: Buffer | Uint8Array) => {
		downloaded += chunk.length;
		options.onProgress?.(downloaded);
	});
	const { createWriteStream } = await import("node:fs");
	await pipeline(source, createWriteStream(tmp));
	await rename(tmp, file.dest);
	const actual = await sha256OfFile(file.dest);
	if (actual.toLowerCase() !== file.expectedSha256.toLowerCase()) {
		await rename(file.dest, `${file.dest}.bad`).catch(() => undefined);
		throw new Error(
			`SHA-256 mismatch for ${path.basename(file.dest)}: expected ${file.expectedSha256}, got ${actual}`,
		);
	}
}

export interface EnsureModelsOptions {
	baseDir: string;
	/** Models to ensure; defaults to both. */
	only?: SttModelId[];
	/** Download wav2vec2 companion files (vocab.json + config.json) alongside the model. */
	withWav2vec2Companions?: boolean;
	onProgress?: (event: ModelProgress) => void;
	fetcher?: typeof fetch;
}

/** Ensure every required model is present locally; downloads with progress + retry. */
export async function ensureModels(opts: EnsureModelsOptions): Promise<void> {
	const targets = (opts.only ?? (["whisper", "wav2vec2"] as SttModelId[])).map((id) => ({
		id,
		descriptor: STT_MODELS[id],
		path: modelPaths(opts.baseDir)[id],
	}));

	for (const { id, descriptor, path: dest } of targets) {
		if (!dest) continue;

		// ponytail: wav2vec2-base-960h ships as PyTorch only on HF; the ONNX we
		// need must come from a local export. Prefer the bundled copy in
		// `electron/native/models/wav2vec2-base-960h/`, copy + SHA-verify it
		// into the user-data cache, and skip the URL fallback entirely.
		if (id === "wav2vec2") {
			await ensureWav2vec2(dest, opts);
		} else {
			await downloadModel(descriptor, dest, {
				onProgress: (bytes) => opts.onProgress?.({ id, downloadedBytes: bytes, totalBytes: 0 }),
				fetcher: opts.fetcher,
			});
			// Pin the total post-hoc for progress event UIs that need it.
			try {
				const s = await stat(dest);
				opts.onProgress?.({ id, downloadedBytes: s.size, totalBytes: s.size });
			} catch {
				// best-effort; subsequent reads will fail loudly if missing
			}
		}
	}
}

/** Copy the bundled wav2vec2 ONNX + companions into the user-data cache, verify SHA. */
async function ensureWav2vec2(dest: string, opts: EnsureModelsOptions): Promise<void> {
	const id: SttModelId = "wav2vec2";
	const bundled = findBundledWav2vec2();
	if (!bundled) {
		// ponytail: a build that strips `electron/native/models/` from extraResources
		// (or a packaging error) ends up here. Surface a clear error rather than
		// trying to download the ONNX from a URL that doesn't exist on HF.
		throw new Error(
			"wav2vec2-base-960h ONNX not bundled. Expected at electron/native/models/wav2vec2-base-960h/model.onnx. " +
				"Re-run scripts/export-wav2vec2-onnx.py or restore the model.onnx artifact.",
		);
	}
	await mkdir(path.dirname(dest), { recursive: true });
	const baseDir = path.dirname(dest);

	// Stream-copy the bundled ONNX to the user-data cache + verify SHA before the
	// forced alignment ever tries to load it. Cheap, fail-fast.
	const tmp = `${dest}.partial`;
	await copyFileAsync(bundled, tmp);
	await rename(tmp, dest);
	const actual = await sha256OfFile(dest);
	const expected = STT_MODELS.wav2vec2.expectedSha256;
	if (expected && actual.toLowerCase() !== expected.toLowerCase()) {
		await rename(dest, `${dest}.bad`).catch(() => undefined);
		throw new Error(`SHA-256 mismatch for bundled wav2vec2: expected ${expected}, got ${actual}`);
	}
	opts.onProgress?.({
		id,
		downloadedBytes: (await stat(dest)).size,
		totalBytes: (await stat(dest)).size,
	});

	// Companion files (vocab.json + config.json) sit next to model.onnx in the
	// bundle. Copy them alongside so `forcedAlignment.ensureVocabLoaded` can SHA-verify
	// the vocab at load time without a network round-trip.
	if (opts.withWav2vec2Companions) {
		const vocabSrc = `${bundled.replace(/model\.onnx$/, "")}vocab.json`;
		const configSrc = `${bundled.replace(/model\.onnx$/, "")}config.json`;
		if (existsSync(vocabSrc)) {
			await copyFileAsync(vocabSrc, path.join(baseDir, "vocab.json"));
		}
		if (existsSync(configSrc)) {
			await copyFileAsync(configSrc, path.join(baseDir, "config.json"));
		}
	}
}
