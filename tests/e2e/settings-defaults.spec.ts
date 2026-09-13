import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { _electron as electron, expect, test } from "@playwright/test";
import { DEFAULT_PROJECT_APPEARANCE } from "../../src/lib/projectDefaults";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
const MAIN_JS = path.join(ROOT, "dist-electron/main.js");
type ElectronApplication = Awaited<ReturnType<typeof electron.launch>>;
type ProjectResult = {
	success: boolean;
	document: { project: { id: string }; legacyEditor: Record<string, unknown> };
};

async function launch(userData: string, temp: string) {
	return electron.launch({
		args: [
			MAIN_JS,
			"--no-sandbox",
			"--enable-unsafe-swiftshader",
			"--lang=en-US",
			`--user-data-dir=${userData}`,
		],
		env: {
			...process.env,
			ELECTRON_USER_DATA_DIR: userData,
			TMPDIR: temp,
			TMP: temp,
			TEMP: temp,
			HEADLESS: process.env["HEADLESS"] ?? "true",
		},
	});
}

async function close(app: ElectronApplication) {
	const process = app.process();
	await Promise.race([app.close(), new Promise<void>((resolve) => setTimeout(resolve, 5_000))]);
	if (process.exitCode === null && process.signalCode === null) {
		process.kill("SIGKILL");
		await Promise.race([
			once(process, "close"),
			new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
		]);
	}
}

test("recording setup and new-project appearance survive a real Electron restart", async () => {
	const userData = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-settings-e2e-"));
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), "openscreen-settings-e2e-tmp-"));
	let app: ElectronApplication | null = null;
	try {
		app = await launch(userData, temp);
		const firstWindow = await app.firstWindow({ timeout: 60_000 });
		const custom = { ...DEFAULT_PROJECT_APPEARANCE, wallpaper: "#123456", padding: 17 };
		await firstWindow.evaluate(async (defaults) => {
			await window.electronAPI.setRecordingPrefs({
				micEnabled: true,
				micDeviceId: "persisted-mic",
				micDeviceName: "Persisted microphone",
				systemAudioEnabled: true,
			});
			await window.electronAPI.setProjectAppearanceDefaults(defaults);
		}, custom);
		const existing = await firstWindow.evaluate(() =>
			window.electronAPI.invokeNativeBridge<ProjectResult>({
				domain: "aiEdition",
				action: "document.create",
				payload: { title: "Before restart" },
			}),
		);
		expect(existing.ok).toBe(true);
		if (!existing.ok) throw new Error(existing.error.message);
		const existingId = existing.data?.document.project.id;
		expect(existing.data?.document.legacyEditor).toMatchObject({
			wallpaper: "#123456",
			padding: 17,
		});
		await close(app);
		app = null;

		app = await launch(userData, temp);
		const restartedWindow = await app.firstWindow({ timeout: 60_000 });
		const restored = await restartedWindow.evaluate(() => window.electronAPI.getAppSettings());
		expect(restored.recording).toMatchObject({
			micEnabled: true,
			micDeviceId: "persisted-mic",
			micDeviceName: "Persisted microphone",
			systemAudioEnabled: true,
		});
		expect(restored.appearance).toMatchObject({ custom: true, defaults: custom });

		const after = await restartedWindow.evaluate(async (oldId) => {
			const oldProject = await window.electronAPI.invokeNativeBridge<ProjectResult>({
				domain: "aiEdition",
				action: "document.get",
				payload: { projectId: oldId },
			});
			const fresh = await window.electronAPI.invokeNativeBridge<ProjectResult>({
				domain: "aiEdition",
				action: "document.create",
				payload: { title: "After restart" },
			});
			return { oldProject, fresh };
		}, existingId);
		expect(after.oldProject.ok).toBe(true);
		expect(after.fresh.ok).toBe(true);
		if (!after.oldProject.ok) throw new Error(after.oldProject.error.message);
		if (!after.fresh.ok) throw new Error(after.fresh.error.message);
		expect(after.oldProject.data.document.legacyEditor).toMatchObject({ padding: 17 });
		expect(after.fresh.data.document.legacyEditor).toMatchObject({ padding: 17 });
	} finally {
		if (app) await close(app);
		for (const directory of [userData, temp])
			fs.rmSync(directory, { recursive: true, force: true });
	}
});
