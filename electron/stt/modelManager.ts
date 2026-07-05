import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
// ponytail: `tar` is npm's own extraction utility (used by `npm pack`/`npm
// publish`), actively maintained, and trivially small. Reaching for it over
// a hand-rolled gunzip+untar routine is one fewer stream pipeline to debug
// at 3am when a download is partially corrupt.
import { extract } from "tar";

/**
 * Manages the lifetime of the on-disk model artifacts used by the STT stack.
 *
 *  - Whisper: a single CTranslate2-format archive unpacked into a directory
 *    that the CTranslate2 runtime can load directly. The small q5_1 model
 *    weights we used with ggml convert to roughly the same int8-quantized
 *    size under CTranslate2's on-disk format. The archive is downloaded on
 *    first transcription.
 *
 *    ponytail: the URL/digest pair below is a *placeholder* — the
 *    "self-host converted files vs. convert on first run" decision is
 *    explicitly open in the spec ("Model format differs from ggml. Need a
 *    conversion + hosting story for CTranslate2-format Whisper weights
 *    — not yet decided."). A release maintainer flips
 *    `STT_MODELS.whisper.url` + `expectedSha256` here once the hosting
 *    story is resolved. Until then `downloadModel` will surface a 404
 *    loudly instead of silently serving stale weights.
 *
 *  - VAD is gone: word timestamps come from CTranslate2's `.align()` (real
 *    DTW over Whisper's cross-attention weights), which makes Silero VAD
 *    unnecessary for correctness. See
 *    `docs/engineering/stt-ctranslate2-migration.md` § Decision.
 *
 * SHA-256 verification stays — a tampered or partially-downloaded copy of
 * the archive is surfaced as a "hash mismatch", not silently-wrong output.
 */

export type SttModelId = "whisper";

export interface SttModelDescriptor {
	/** Display + cache directory name. */
	cacheDir: string;
	/** Filename on disk and the URL tail. */
	file: string;
	/** HTTPS URL to download from. */
	url: string;
	/**
	 * Expected SHA-256 of the final archive. `null` disables verification —
	 * used in tests and when deliberately running on a CI box without network
	 * access; production builds ship with `null` lifted to a real digest
	 * before the first RC.
	 */
	expectedSha256: string | null;
	/** Approximate size used for progress reporting; not enforced. */
	approximateBytes: number;
}

export const STT_MODELS: Record<SttModelId, SttModelDescriptor> = {
	// ponytail: placeholder URL — see the class doc above. Replace with the
	// real pre-converted archive URL + SHA-256 once the hosting story from
	// the migration doc has been decided.
	whisper: {
		cacheDir: "whisper-ct2",
		file: "whisper-small-ct2-int8.tar.gz",
		url: "https://example.invalid/openscreen/whisper-small-ct2-int8.tar.gz",
		expectedSha256: null,
		approximateBytes: 200_000_000,
	},
};

/** ponytail: single source of truth so the build script + the runtime verifier
 * read the same digest. Update this map (and the `expectedSha256` field
 * directly) before tagging a release that changes the archive. */
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
		whisper: path.join(baseDir, STT_MODELS.whisper.cacheDir),
	};
}

/**
 * True when the unpacked CTranslate2 model directory exists and contains at
 * least one file. CTranslate2's runtime expects a directory, not a single
 * blob, so the gate is presence-of-contents rather than `stat().size > 0`.
 */
export async function areModelsPresent(baseDir: string): Promise<boolean> {
	const paths = modelPaths(baseDir);
	try {
		const s = await stat(paths.whisper);
		if (!s.isDirectory()) return false;
		const { readdir } = await import("node:fs/promises");
		const entries = await readdir(paths.whisper);
		return entries.length > 0;
	} catch {
		return false;
	}
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

/**
 * Stream the model archive to disk atomically (`<dest>.partial` → rename on
 * success), verify the SHA-256, then unpack into the cache directory.
 *
 * ponytail: the unpack step runs after the hash verifies, so a tampered
 * archive never lands as an "extracted-and-now-trusted" directory. We
 * extract into `<dest>.unpacked` and rename over the target on success.
 */
export async function downloadModel(
	descriptor: SttModelDescriptor,
	dest: string,
	options: DownloadOptions = {},
): Promise<void> {
	const archivePath = `${dest}.tar.gz`;
	if (existsSync(archivePath)) {
		const s = await stat(archivePath);
		if (s.isFile() && s.size > 0) {
			options.onProgress?.(s.size);
			options.getTotalBytes?.();
			return;
		}
	}

	await mkdir(path.dirname(archivePath), { recursive: true });
	const fetcher = options.fetcher ?? fetch;
	const res = await fetchWithRetry(descriptor.url, fetcher);
	const total = Number.parseInt(res.headers.get("content-length") ?? "", 10);
	if (Number.isFinite(total) && total > 0) {
		options.getTotalBytes?.();
	}
	const tmp = `${archivePath}.partial`;
	let downloaded = 0;
	const source = Readable.fromWeb(res.body as never);
	source.on("data", (chunk: Buffer | Uint8Array) => {
		downloaded += chunk.length;
		options.onProgress?.(downloaded);
	});
	const { createWriteStream } = await import("node:fs");
	await pipeline(source, createWriteStream(tmp));
	await rename(tmp, archivePath);

	const expected = options.expectedSha256 ?? descriptor.expectedSha256;
	if (expected) {
		const actual = await sha256OfFile(archivePath);
		if (actual.toLowerCase() !== expected.toLowerCase()) {
			// ponytail: keep the bad file under a `.bad` suffix so a maintainer
			// can compare against the upstream — but never present it as a valid
			// model.
			await rename(archivePath, `${archivePath}.bad`).catch(() => undefined);
			throw new Error(
				`SHA-256 mismatch for ${descriptor.file}: expected ${expected}, got ${actual}`,
			);
		}
	}

	const stagingDir = `${dest}.unpacked`;
	// ponytail: `tar.extract({cwd})` requires the directory to exist before
	// `chdir`-ing into it. Cheap to create up front; saves a CwdError in
	// the (very common) "first time we ever fetch this model" code path.
	await mkdir(stagingDir, { recursive: true });
	await extract({ file: archivePath, cwd: stagingDir });
	// ponytail: Windows refuses `rename(stagingDir, dest)` when `dest` already
	// exists (EPERM) — the pre-extract `mkdir(dest)` above is therefore
	// lazy/deleted from this code path. If `dest` somehow exists from a
	// previous run, blow it away before renaming.
	if (existsSync(dest)) {
		const { rm } = await import("node:fs/promises");
		await rm(dest, { recursive: true, force: true });
	}
	await rename(stagingDir, dest);
}

export interface EnsureModelsOptions {
	baseDir: string;
	/** Models to ensure; defaults to all (currently just `whisper`). */
	only?: SttModelId[];
	onProgress?: (event: ModelProgress) => void;
	fetcher?: typeof fetch;
}

/** Ensure every required model is present locally; downloads with progress + retry. */
export async function ensureModels(opts: EnsureModelsOptions): Promise<void> {
	const targets = (opts.only ?? (["whisper"] as SttModelId[])).map((id) => ({
		id,
		descriptor: STT_MODELS[id],
		path: modelPaths(opts.baseDir)[id],
	}));

	for (const { id, descriptor, path: dest } of targets) {
		if (await areModelsPresent(opts.baseDir)) continue;
		await downloadModel(descriptor, dest, {
			onProgress: (bytes) => opts.onProgress?.({ id, downloadedBytes: bytes, totalBytes: 0 }),
			fetcher: opts.fetcher,
		});
		// Pin the total post-hoc for progress event UIs that need it.
		try {
			const { readdir, stat: statDir } = await import("node:fs/promises");
			const files = await readdir(dest);
			let total = 0;
			for (const f of files) {
				const s = await statDir(path.join(dest, f));
				if (s.isFile()) total += s.size;
			}
			opts.onProgress?.({ id, downloadedBytes: total, totalBytes: total });
		} catch {
			// best-effort; subsequent reads will fail loudly if missing
		}
	}
}
