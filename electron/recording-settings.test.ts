import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAutoZoomEnabled, saveAutoZoomEnabled } from "./recording-settings";

const temps: string[] = [];
const tmp = () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-recording-settings-"));
	temps.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("recording settings", () => {
	it("defaults to on for absent, malformed, and invalid settings", () => {
		const dir = tmp();
		expect(loadAutoZoomEnabled(dir)).toBe(true);
		for (const raw of ["{broken", "null", "[]", "42", "{}", '{"autoZoomEnabled":"false"}']) {
			writeFileSync(path.join(dir, "recording-settings.json"), raw);
			expect(loadAutoZoomEnabled(dir)).toBe(true);
		}
	});

	it("round-trips false and true without overwriting unrelated keys", () => {
		const dir = tmp();
		const file = path.join(dir, "recording-settings.json");
		writeFileSync(file, '{"futurePreference":"keep"}');
		for (const enabled of [false, true]) {
			saveAutoZoomEnabled(dir, enabled);
			expect(loadAutoZoomEnabled(dir)).toBe(enabled);
			expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
				futurePreference: "keep",
				autoZoomEnabled: enabled,
			});
		}
	});

	it("loads the disabled preference through a fresh store instance", () => {
		const dir = tmp();
		saveAutoZoomEnabled(dir, false);
		expect(loadAutoZoomEnabled(dir)).toBe(false);
	});

	it("rejects invalid writes and reports a failed disk write", () => {
		const dir = tmp();
		saveAutoZoomEnabled(dir, false);
		expect(() => saveAutoZoomEnabled(dir, "false" as unknown as boolean)).toThrow(TypeError);
		expect(loadAutoZoomEnabled(dir)).toBe(false);
		expect(() => saveAutoZoomEnabled(path.join(dir, "missing"), true)).toThrow();
	});
});
