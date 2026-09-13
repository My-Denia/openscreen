import { AppSettingsStore, type RecordingPreferences } from "./app-settings";

/** Back-compatible auto-zoom reader used by existing callers and tests. */
export function loadAutoZoomEnabled(userData: string): boolean {
	return new AppSettingsStore(userData).getSnapshot().recording.autoZoomEnabled;
}

/** Back-compatible auto-zoom writer; the canonical store owns every recording preference. */
export function saveAutoZoomEnabled(userData: string, enabled: boolean): void {
	new AppSettingsStore(userData).setRecordingPreferences({ autoZoomEnabled: enabled });
}

export function loadRecordingPreferences(userData: string): RecordingPreferences {
	return new AppSettingsStore(userData).getSnapshot().recording;
}

export function saveRecordingPreferences(
	userData: string,
	patch: Partial<RecordingPreferences>,
): RecordingPreferences {
	return new AppSettingsStore(userData).setRecordingPreferences(patch).recording;
}
