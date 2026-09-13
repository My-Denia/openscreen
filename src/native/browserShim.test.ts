// @vitest-environment jsdom
// The shim persists projects to localStorage, so this needs a DOM.
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { DEFAULT_PROJECT_APPEARANCE } from "@/lib/projectDefaults";
import { installBrowserShims } from "./browserShim";
import { nativeBridgeClient } from "./client";

// The bridge contract types `document` as `unknown`; the shim returns real
// AxcutDocuments, so narrow here rather than reaching for `any`.
const asDoc = (d: unknown) => d as AxcutDocument;

// installBrowserShims patches the real nativeBridgeClient's methods in place, so
// installing once is enough; each test starts from a clean localStorage. The
// `?browser` query is what flips detectBrowserMode() on outside Electron.
beforeAll(() => {
	window.history.replaceState(null, "", "/?browser");
	installBrowserShims();
});
beforeEach(() => {
	localStorage.clear();
});

async function freshProjectId(): Promise<string> {
	const created = await nativeBridgeClient.aiEdition.create("P");
	const id = asDoc(created.document).project.id;
	if (!id) throw new Error("shim create returned no project");
	return id;
}

describe("browserShim addAsset (issue #350)", () => {
	it("keeps kind 'audio' and does not claim the empty primary slot", async () => {
		const projectId = await freshProjectId();
		const res = await nativeBridgeClient.aiEdition.addAsset(
			projectId,
			"/tmp/music.mp3",
			"music",
			"audio",
		);
		const doc = asDoc(res.document);
		const asset = doc.assets.at(-1);
		expect(asset?.kind).toBe("audio");
		// An audio import must never become the primary asset (mirrors the main
		// process's document-service.addAsset).
		expect(doc.project.primaryAssetId).toBeUndefined();
	});

	it("still lets a video import claim the empty primary slot", async () => {
		const projectId = await freshProjectId();
		const res = await nativeBridgeClient.aiEdition.addAsset(
			projectId,
			"/tmp/screen.mp4",
			"screen",
			"video",
		);
		const doc = asDoc(res.document);
		const asset = doc.assets.at(-1);
		expect(asset?.kind).toBe("video");
		expect(doc.project.primaryAssetId).toBe(asset?.id);
	});
});

describe("browserShim app settings", () => {
	it("materializes versioned appearance defaults into a new browser project", async () => {
		await window.electronAPI.setProjectAppearanceDefaults({
			...DEFAULT_PROJECT_APPEARANCE,
			wallpaper: "#abcdef",
			padding: 9,
		});
		const created = await nativeBridgeClient.aiEdition.create("Defaults");
		expect(asDoc(created.document).legacyEditor).toMatchObject({
			wallpaper: "#abcdef",
			padding: 9,
		});
	});

	it("publishes recording settings only after localStorage succeeds", async () => {
		await window.electronAPI.resetRecordingSetup();
		const setItem = Storage.prototype.setItem;
		Storage.prototype.setItem = () => {
			throw new Error("storage unavailable");
		};
		try {
			await expect(window.electronAPI.setRecordingPrefs({ micEnabled: true })).rejects.toThrow(
				"storage unavailable",
			);
			expect((await window.electronAPI.getRecordingPrefs()).micEnabled).toBe(false);
		} finally {
			Storage.prototype.setItem = setItem;
		}
	});

	it("notifies recording and source subscribers on changes and reset", async () => {
		const prefsEvents: boolean[] = [];
		const sourceEvents: Array<string | null> = [];
		const stopPrefs = window.electronAPI.onRecordingPrefsChanged((prefs) =>
			prefsEvents.push(prefs.micEnabled),
		);
		const stopSource = window.electronAPI.onSelectedSourceChanged((source) =>
			sourceEvents.push(source?.id ?? null),
		);

		await window.electronAPI.setRecordingPrefs({ micEnabled: true });
		const source = (await window.electronAPI.getSources({ types: ["screen"] }))[0];
		await window.electronAPI.selectSource(source);
		await window.electronAPI.resetRecordingSetup();

		expect(prefsEvents).toEqual([true, false]);
		expect(sourceEvents).toEqual([source.id, null]);
		stopPrefs();
		stopSource();
		await window.electronAPI.setRecordingPrefs({ micEnabled: true });
		expect(prefsEvents).toEqual([true, false]);
	});
});
