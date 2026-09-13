import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RecordingPrefs } from "./handlers";
import { registerRecordingPrefsHandlers } from "./recordingPrefs";

const electron = vi.hoisted(() => ({ getPath: vi.fn(), handle: vi.fn() }));
vi.mock("electron", () => ({
	app: { getPath: electron.getPath },
	ipcMain: { handle: electron.handle },
}));

const defaults: RecordingPrefs = {
	micEnabled: false,
	micDeviceId: null,
	micDeviceName: null,
	camEnabled: false,
	camDeviceId: null,
	camDeviceName: null,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay",
	autoZoomEnabled: true,
};
let dir: string;
beforeEach(() => {
	dir = mkdtempSync(path.join(os.tmpdir(), "openscreen-recording-ipc-"));
	electron.getPath.mockReturnValue(dir);
	electron.handle.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function start(
	getWindow: () => BrowserWindow | null = () => null,
	onResetSource: () => void = () => undefined,
	getAppWindows?: () => BrowserWindow[],
) {
	electron.handle.mockClear();
	registerRecordingPrefsHandlers(defaults, getWindow, onResetSource, getAppWindows);
	const get = electron.handle.mock.calls.find(
		([name]) => name === "get-recording-prefs",
	)?.[1] as () => RecordingPrefs;
	const set = electron.handle.mock.calls.find(([name]) => name === "set-recording-prefs")?.[1] as (
		_event: unknown,
		prefs: Partial<RecordingPrefs>,
	) => RecordingPrefs;
	const reset = electron.handle.mock.calls.find(
		([name]) => name === "reset-recording-setup",
	)?.[1] as (_event: unknown) => { recording: RecordingPrefs; lastSource: null };
	return {
		get,
		set: (prefs: Partial<RecordingPrefs>) => set(undefined, prefs),
		reset: () => reset(undefined),
	};
}

describe("recording preferences IPC", () => {
	it("restores toggles and device preferences on restart", () => {
		const first = start();
		expect(first.get().autoZoomEnabled).toBe(true);
		expect(first.set({ autoZoomEnabled: false }).autoZoomEnabled).toBe(false);
		first.set({ micEnabled: true, micDeviceId: "temporary-device" });
		const disk = JSON.parse(readFileSync(path.join(dir, "recording-settings.json"), "utf8"));
		expect(disk).toMatchObject({
			autoZoomEnabled: false,
			micEnabled: true,
			micDeviceId: "temporary-device",
		});
		const restarted = start();
		expect(restarted.get()).toEqual({
			...defaults,
			autoZoomEnabled: false,
			micEnabled: true,
			micDeviceId: "temporary-device",
		});
		restarted.set({ autoZoomEnabled: true });
		expect(start().get().autoZoomEnabled).toBe(true);
	});

	it("broadcasts saved values to every live application window", () => {
		const firstSend = vi.fn();
		const secondSend = vi.fn();
		const destroyedSend = vi.fn();
		const first = {
			isDestroyed: () => false,
			webContents: { send: firstSend },
		} as unknown as BrowserWindow;
		const second = {
			isDestroyed: () => false,
			webContents: { send: secondSend },
		} as unknown as BrowserWindow;
		const destroyed = {
			isDestroyed: () => true,
			webContents: { send: destroyedSend },
		} as unknown as BrowserWindow;
		const session = start(
			() => first,
			undefined,
			() => [first, second, first, destroyed],
		);
		const updated = session.set({ autoZoomEnabled: false });
		expect(firstSend).toHaveBeenCalledWith("recording-prefs-changed", updated);
		expect(secondSend).toHaveBeenCalledWith("recording-prefs-changed", updated);
		expect(firstSend).toHaveBeenCalledTimes(1);
		expect(destroyedSend).not.toHaveBeenCalled();
	});

	it("publishes the reset snapshot and runs the source reset callback", () => {
		const send = vi.fn();
		const window = {
			isDestroyed: () => false,
			webContents: { send },
		} as unknown as BrowserWindow;
		const onResetSource = vi.fn();
		const session = start(() => window, onResetSource);
		session.set({ micEnabled: true, camEnabled: true, systemAudioEnabled: true });
		send.mockClear();

		const snapshot = session.reset();
		expect(snapshot.recording).toEqual(defaults);
		expect(snapshot.lastSource).toBeNull();
		expect(onResetSource).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith("recording-prefs-changed", defaults);
	});

	it("does not publish an invalid or failed preference write", () => {
		const session = start();
		expect(() =>
			session.set({ autoZoomEnabled: null } as unknown as Partial<RecordingPrefs>),
		).toThrow(TypeError);
		expect(session.get().autoZoomEnabled).toBe(true);
		session.set({ autoZoomEnabled: false });
		session.set({ autoZoomEnabled: undefined, camEnabled: true });
		expect(session.get().autoZoomEnabled).toBe(false);
		rmSync(dir, { recursive: true, force: true });
		expect(() => session.set({ autoZoomEnabled: true })).toThrow();
		expect(session.get().autoZoomEnabled).toBe(false);
	});
});
