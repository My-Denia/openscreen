import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_APPEARANCE } from "../src/lib/projectDefaults";
import { AppSettingsStore, DEFAULT_RECORDING_PREFERENCES } from "./app-settings";

const dirs: string[] = [];
const temp = () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-app-settings-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("app settings store", () => {
	it("migrates the auto-zoom-only shape and preserves unknown keys", () => {
		const dir = temp();
		const file = path.join(dir, "recording-settings.json");
		writeFileSync(file, JSON.stringify({ autoZoomEnabled: false, future: { keep: true } }));
		const store = new AppSettingsStore(dir);
		expect(store.getSnapshot().recording.autoZoomEnabled).toBe(false);
		store.setRecordingPreferences({ micEnabled: true, camDeviceName: "Camera A" });
		expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
			future: { keep: true },
			autoZoomEnabled: false,
			micEnabled: true,
			camDeviceName: "Camera A",
		});
	});

	it("uses validated defaults for absent, corrupt, and invalid fields", () => {
		const dir = temp();
		const file = path.join(dir, "recording-settings.json");
		const store = new AppSettingsStore(dir);
		expect(store.getSnapshot().recording).toEqual(DEFAULT_RECORDING_PREFERENCES);
		for (const raw of ["{broken", "[]", JSON.stringify({ micEnabled: "yes" })]) {
			writeFileSync(file, raw);
			expect(store.getSnapshot().recording.micEnabled).toBe(false);
		}
	});

	it("stores and resets versioned appearance and recording setup", () => {
		const dir = temp();
		const store = new AppSettingsStore(dir);
		const custom = { ...DEFAULT_PROJECT_APPEARANCE, wallpaper: "#010203", padding: 7 };
		expect(store.setAppearanceDefaults(custom).appearance).toMatchObject({ custom: true });
		store.setLastSource({
			platform: "win32",
			kind: "screen",
			id: "screen:1",
			name: "Display",
			displayId: "1",
		});
		store.setRecordingPreferences({ micEnabled: true, micDeviceId: "mic" });
		expect(store.resetRecordingSetup()).toMatchObject({
			recording: DEFAULT_RECORDING_PREFERENCES,
			lastSource: null,
		});
		expect(store.resetAppearanceDefaults().appearance).toEqual({
			version: 1,
			custom: false,
			defaults: DEFAULT_PROJECT_APPEARANCE,
		});
		expect(
			JSON.parse(readFileSync(path.join(dir, "recording-settings.json"), "utf8")),
		).toMatchObject({
			projectAppearance: { version: 1, defaults: null },
		});
	});

	it("rejects invalid or failed writes without changing the published durable value", () => {
		const dir = temp();
		const store = new AppSettingsStore(dir);
		store.setRecordingPreferences({ micEnabled: true });
		expect(() => store.setRecordingPreferences({ micEnabled: "yes" as never })).toThrow(TypeError);
		expect(store.getSnapshot().recording.micEnabled).toBe(true);
		const missing = new AppSettingsStore(path.join(dir, "missing"));
		expect(() => missing.setRecordingPreferences({ micEnabled: true })).toThrow();
		expect(missing.getSnapshot().recording.micEnabled).toBe(false);
	});
});
