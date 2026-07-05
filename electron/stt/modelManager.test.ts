import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	areModelsPresent,
	downloadModel,
	ensureModels,
	expectedSha256For,
	modelPaths,
	STT_MODELS,
} from "./modelManager";

describe("modelManager", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(path.join(tmpdir(), "stt-models-"));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("exposes the whisper model in CTranslate2 format", () => {
		expect(STT_MODELS.whisper.cacheDir).toBe("whisper-ct2");
		expect(STT_MODELS.whisper.file).toMatch(/^whisper-small-ct2/);
		expect(STT_MODELS.whisper.file.endsWith(".tar.gz")).toBe(true);
		expect(STT_MODELS.whisper.approximateBytes).toBeGreaterThan(0);
	});

	it("modelPaths places the whisper unpacked dir under the cache directory", () => {
		const paths = modelPaths(dir);
		expect(paths.whisper).toBe(path.join(dir, "whisper-ct2"));
	});

	it("expectedSha256For reports the whisper model digest", () => {
		// ponytail: the hash is null by design — see modelManager.ts doc
		// comment for the "self-host converted files vs. convert on first
		// run" question that's still open from the migration doc. Locked
		// before the first RC.
		expect(expectedSha256For("whisper")).toBeNull();
	});

	it("areModelsPresent returns false when no model directory exists", async () => {
		expect(await areModelsPresent(dir)).toBe(false);
	});

	it("areModelsPresent returns true once the whisper directory is non-empty", async () => {
		const paths = modelPaths(dir);
		await mkdir(paths.whisper, { recursive: true });
		expect(await areModelsPresent(dir)).toBe(false);
		await writeFile(path.join(paths.whisper, "config.json"), "{}");
		expect(await areModelsPresent(dir)).toBe(true);
	});

	it("downloadModel skips re-download when the archive is already present", async () => {
		// ponytail: production computes archivePath as `${dest}.tar.gz`; write
		// to the same path so the early-return fires before fetch/extract.
		const dest = path.join(dir, "out");
		const archivePath = `${dest}.tar.gz`;
		await mkdir(path.dirname(archivePath), { recursive: true });
		await writeFile(archivePath, "already here");
		let fetcherCalled = 0;
		const fetcher: typeof fetch = async () => {
			fetcherCalled++;
			return new Response("should not be read", { status: 200 });
		};
		let progressCalls = 0;
		await downloadModel(STT_MODELS.whisper, dest, {
			fetcher,
			onProgress: () => progressCalls++,
		});
		expect(fetcherCalled).toBe(0);
		// Archive progress callback still fires for the cached file.
		expect(progressCalls).toBeGreaterThan(0);
		const s = await stat(archivePath);
		expect(s.size).toBe("already here".length);
	});

	it("downloadModel streams the archive to disk and unpacks into the destination", async () => {
		// Build a real (tiny) .tar archive so the unpack step actually
		// exercises the tar extraction path. ponytail: previous versions of
		// this test only checked stream mechanics; this version verifies the
		// unpack lands files where the CTranslate2 runtime expects them.
		const tarBuffer = await buildTarWith([
			{ name: "model.bin", content: Buffer.from("weights bytestream") },
			{ name: "config.json", content: Buffer.from("{}") },
		]);
		const dest = path.join(dir, "streamed");
		await mkdir(path.dirname(dest), { recursive: true });

		const fakeResponse = new Response(tarBuffer, { status: 200 });
		const fetcher: typeof fetch = async () => fakeResponse;
		const bytes: number[] = [];
		// Disable SHA-256 verification — this is a fake archive.
		const descriptor = { ...STT_MODELS.whisper, expectedSha256: null };
		await downloadModel(descriptor, dest, {
			fetcher,
			onProgress: (b) => bytes.push(b),
		});

		const ls = await readdir(dest);
		expect(ls).toContain("model.bin");
		expect(ls).toContain("config.json");
		expect(bytes.at(-1)).toBe(tarBuffer.length);
		// Progress is cumulative and strictly non-decreasing.
		for (let i = 1; i < bytes.length; i++) {
			expect(bytes[i]).toBeGreaterThanOrEqual(bytes[i - 1] ?? 0);
		}
	});

	it("ensureModels only invokes ensure per model and reuses existing directories", async () => {
		const paths = modelPaths(dir);
		await mkdir(paths.whisper, { recursive: true });
		await writeFile(path.join(paths.whisper, "config.json"), "{}");
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			return new Response(Readable.from(["x"]) as unknown as BodyInit, { status: 200 });
		};
		await ensureModels({
			baseDir: dir,
			only: ["whisper"],
			fetcher,
			onProgress: () => undefined,
		});
		// Cache hit: no fetch fires for the existing directory.
		expect(fetches).toBe(0);
	});

	it("downloadModel surfaces 4xx errors immediately instead of retrying", async () => {
		const dest = path.join(dir, "locked");
		await mkdir(path.dirname(dest), { recursive: true });
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			// 401 — auth-gated; retrying won't help. Spec behavior: fail fast.
			return new Response("auth required", { status: 401, statusText: "Unauthorized" });
		};
		await expect(downloadModel(STT_MODELS.whisper, dest, { fetcher })).rejects.toThrow(
			/HTTP 401 Unauthorized/,
		);
		expect(fetches).toBe(1); // single attempt, no 60s backoff loop
	});

	it("downloadModel retries transient 5xx + network errors with bounded backoff", async () => {
		const dest = path.join(dir, "flaky");
		await mkdir(path.dirname(dest), { recursive: true });
		let fetches = 0;
		const fetcher: typeof fetch = async () => {
			fetches++;
			if (fetches < 2)
				return new Response("busy", { status: 503, statusText: "Service Unavailable" });
			// Small valid tar so the unpack step doesn't blow up; the test
			// only cares that the retry succeeded — the unpack is incidental.
			const tar = await buildTarWith([{ name: "config.json", content: Buffer.from("{}") }]);
			return new Response(tar, { status: 200 });
		};
		// expectedSha256: null — this test is about retry/backoff mechanics.
		await downloadModel({ ...STT_MODELS.whisper, expectedSha256: null }, dest, { fetcher });
		expect(fetches).toBe(2); // one retry, then success
	});
});

/** Build a plain tar archive containing the given files; test-only fixture. */
async function buildTarWith(files: Array<{ name: string; content: Buffer }>): Promise<Buffer> {
	// ponytail: the `tar` package's lower-level `Pack` API changed shape in
	// tar@7 (it's a streaming entry pump now). The high-level `tar.c(opts, paths)`
	// helper writes entries from disk paths in one call — simpler and the
	// shape is stable across recent releases. Lay each fixture file on disk
	// under a temp cwd, then point tar.c at it.
	const cwd = path.join(tmpdir(), `stt-fixtures-${Date.now()}-${Math.random()}`);
	const tarPath = path.join(tmpdir(), `stt-archive-${Date.now()}-${Math.random()}.tar`);
	await mkdir(cwd, { recursive: true });
	for (const f of files) {
		const target = path.join(cwd, f.name);
		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, f.content);
	}
	const { c } = await import("tar");
	await c(
		{ gzip: false, cwd, file: tarPath },
		files.map((f) => f.name),
	);
	const { readFile, rm } = await import("node:fs/promises");
	const buf = await readFile(tarPath);
	// Cleanup the fixture tree + tarball. Keep `buf` in memory for the test.
	await rm(cwd, { recursive: true, force: true });
	await rm(tarPath, { force: true });
	return buf;
}
