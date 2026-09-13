import { app, type BrowserWindow, ipcMain } from "electron";
import type { ProjectAppearanceDefaults } from "../../src/lib/projectDefaults";
import { AppSettingsStore } from "../app-settings";
import type { RecordingPrefs } from "./handlers";

/** Shared durable recording preferences. Persist before publishing any new snapshot. */
export function registerRecordingPrefsHandlers(
	defaults: RecordingPrefs,
	getMainWindow: () => BrowserWindow | null,
	onResetSource: () => void = () => undefined,
	getAppWindows: () => BrowserWindow[] = () => {
		const mainWindow = getMainWindow();
		return mainWindow ? [mainWindow] : [];
	},
): void {
	const userData = app.getPath("userData");
	const settings = new AppSettingsStore(userData);
	let recordingPrefs = { ...defaults, ...settings.getSnapshot().recording };
	const publish = () => {
		for (const window of new Set(getAppWindows())) {
			if (!window.isDestroyed()) {
				window.webContents.send("recording-prefs-changed", recordingPrefs);
			}
		}
	};

	ipcMain.handle("get-recording-prefs", () => recordingPrefs);
	ipcMain.handle("set-recording-prefs", (_, prefs: Partial<RecordingPrefs>) => {
		// Persist every validated field first. A failed save must leave both the
		// durable value and the main-process published snapshot unchanged.
		recordingPrefs = settings.setRecordingPreferences(prefs).recording;
		publish();
		return recordingPrefs;
	});

	ipcMain.handle("get-app-settings", () => settings.getSnapshot());
	ipcMain.handle("set-project-appearance-defaults", (_, value: ProjectAppearanceDefaults) =>
		settings.setAppearanceDefaults(value),
	);
	ipcMain.handle("reset-project-appearance-defaults", () => settings.resetAppearanceDefaults());
	ipcMain.handle("reset-recording-setup", () => {
		const snapshot = settings.resetRecordingSetup();
		recordingPrefs = snapshot.recording;
		onResetSource();
		publish();
		return snapshot;
	});
}
