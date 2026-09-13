// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EditorDialogsProvider, useEditorDialogActions } from "@/contexts/EditorDialogsContext";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { DEFAULT_PROJECT_APPEARANCE } from "@/lib/projectDefaults";
import { AppSettingsDialog } from "./AppSettings";

const project = vi.hoisted(() => ({
	document: null as ReturnType<typeof createEmptyDocument> | null,
}));
vi.mock("@/lib/ai-edition/store/projectStore", () => ({
	useProjectStore: (selector: (state: typeof project) => unknown) => selector(project),
}));
const microphoneHook = vi.hoisted(() => ({
	enabled: [] as boolean[],
}));
vi.mock("@/hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: (enabled: boolean) => {
		microphoneHook.enabled.push(enabled);
		return {
			devices: [{ deviceId: "mic-live", label: "Live microphone", groupId: "g" }],
			selectedDeviceId: "mic-live",
			setSelectedDeviceId: vi.fn(),
		};
	},
}));
vi.mock("@/hooks/useCameraDevices", () => ({
	useCameraDevices: () => ({
		devices: [{ deviceId: "cam-live", label: "Live camera", groupId: "g" }],
		selectedDeviceId: "cam-live",
		setSelectedDeviceId: vi.fn(),
	}),
}));
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string, vars?: Record<string, string>) =>
		vars ? `${key}:${Object.values(vars).join(":")}` : key,
}));

const recording = {
	micEnabled: false,
	micDeviceId: null,
	micDeviceName: null,
	camEnabled: false,
	camDeviceId: null,
	camDeviceName: null,
	systemAudioEnabled: false,
	cursorCaptureMode: "editable-overlay" as const,
	autoZoomEnabled: true,
};
const snapshot = {
	recording,
	lastSource: null,
	appearance: { version: 1 as const, custom: false, defaults: DEFAULT_PROJECT_APPEARANCE },
};

function OpenSettings() {
	const { openDialog } = useEditorDialogActions();
	return (
		<button type="button" onClick={() => openDialog("settings")}>
			open settings
		</button>
	);
}

function renderSettings() {
	render(
		<EditorDialogsProvider>
			<OpenSettings />
			<AppSettingsDialog />
		</EditorDialogsProvider>,
	);
	fireEvent.click(screen.getByText("open settings"));
}

describe("AppSettings", () => {
	beforeEach(() => {
		microphoneHook.enabled = [];
		project.document = createEmptyDocument({ projectId: "proj_settings", title: "Settings" });
		window.electronAPI = {
			getAppSettings: vi.fn(async () => snapshot),
			setRecordingPrefs: vi.fn(async (value) => ({ ...recording, ...value })),
			setProjectAppearanceDefaults: vi.fn(async (defaults) => ({
				...snapshot,
				appearance: { version: 1 as const, custom: true, defaults },
			})),
			resetProjectAppearanceDefaults: vi.fn(async () => snapshot),
			resetRecordingSetup: vi.fn(async () => snapshot),
		} as unknown as typeof window.electronAPI;
	});

	it("does not enable microphone enumeration until the microphone is on", async () => {
		renderSettings();
		await screen.findByTestId("app-settings-dialog");
		expect(microphoneHook.enabled.at(-1)).toBe(false);
		fireEvent.click(screen.getByLabelText("appSettings.microphone"));
		expect(microphoneHook.enabled.at(-1)).toBe(true);
	});

	it("loads settings and saves edited recording toggles", async () => {
		renderSettings();
		expect(await screen.findByTestId("app-settings-dialog")).toBeInTheDocument();
		fireEvent.click(screen.getByLabelText("appSettings.systemAudio"));
		fireEvent.click(screen.getByText("appSettings.saveRecording"));
		await waitFor(() =>
			expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith(
				expect.objectContaining({ systemAudioEnabled: true }),
			),
		);
		expect(await screen.findByRole("status")).toHaveTextContent("appSettings.saved");
	});

	it("shows a failed save and never reports Saved", async () => {
		vi.mocked(window.electronAPI.setRecordingPrefs).mockRejectedValueOnce(new Error("disk full"));
		renderSettings();
		await screen.findByTestId("app-settings-dialog");
		fireEvent.click(screen.getByText("appSettings.saveRecording"));
		expect(await screen.findByRole("alert")).toHaveTextContent("disk full");
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("shows a load failure without rendering stale settings", async () => {
		vi.mocked(window.electronAPI.getAppSettings).mockRejectedValueOnce(new Error("read failed"));
		renderSettings();
		expect(await screen.findByRole("alert")).toHaveTextContent("read failed");
		expect(screen.queryByText("appSettings.saveRecording")).not.toBeInTheDocument();
	});

	it("copies the current look and exposes both reset actions", async () => {
		renderSettings();
		await screen.findByTestId("app-settings-dialog");
		fireEvent.click(screen.getByText("appSettings.useCurrentAppearance"));
		await waitFor(() =>
			expect(window.electronAPI.setProjectAppearanceDefaults).toHaveBeenCalledWith(
				expect.objectContaining({ padding: 50, aspectRatio: "16:9" }),
			),
		);
		fireEvent.click(screen.getByText("appSettings.resetAppearance"));
		await waitFor(() =>
			expect(window.electronAPI.resetProjectAppearanceDefaults).toHaveBeenCalled(),
		);
		fireEvent.click(screen.getByText("appSettings.resetRecording"));
		await waitFor(() => expect(window.electronAPI.resetRecordingSetup).toHaveBeenCalled());
	});
});
