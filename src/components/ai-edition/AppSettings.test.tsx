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
	selectedDeviceId: "mic-live",
	devices: [{ deviceId: "mic-live", label: "Live microphone", groupId: "g" }],
	isReady: true,
}));
vi.mock("@/hooks/useMicrophoneDevices", () => ({
	useMicrophoneDevices: (enabled: boolean) => {
		microphoneHook.enabled.push(enabled);
		return {
			devices: microphoneHook.devices,
			selectedDeviceId: microphoneHook.selectedDeviceId,
			setSelectedDeviceId: vi.fn(),
			isReady: microphoneHook.isReady,
		};
	},
}));
vi.mock("@/hooks/useCameraDevices", () => ({
	useCameraDevices: () => ({
		devices: [{ deviceId: "cam-live", label: "Live camera", groupId: "g" }],
		selectedDeviceId: "cam-live",
		setSelectedDeviceId: vi.fn(),
		isReady: true,
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
};
const snapshot = {
	recording,
	lastSource: null,
	appearance: { version: 1 as const, custom: false, defaults: DEFAULT_PROJECT_APPEARANCE },
};

function OpenSettings() {
	const { openDialog, closeDialog } = useEditorDialogActions();
	return (
		<>
			<button type="button" onClick={() => openDialog("settings")}>
				open settings
			</button>
			<button type="button" onClick={closeDialog}>
				close settings
			</button>
		</>
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
		microphoneHook.selectedDeviceId = "mic-live";
		microphoneHook.devices = [{ deviceId: "mic-live", label: "Live microphone", groupId: "g" }];
		microphoneHook.isReady = true;
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

	it("does not let a stale save overwrite a newer local edit", async () => {
		let finishSave!: (value: typeof recording) => void;
		vi.mocked(window.electronAPI.setRecordingPrefs).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishSave = resolve;
				}),
		);
		renderSettings();
		await screen.findByTestId("app-settings-dialog");
		fireEvent.click(screen.getByLabelText("appSettings.systemAudio"));
		fireEvent.click(screen.getByText("appSettings.saveRecording"));
		fireEvent.click(screen.getByLabelText("appSettings.systemAudio"));
		expect(screen.getByLabelText("appSettings.systemAudio")).not.toBeChecked();
		finishSave({ ...recording, systemAudioEnabled: true });
		await waitFor(() =>
			expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith(
				expect.objectContaining({ systemAudioEnabled: true }),
			),
		);
		expect(screen.getByLabelText("appSettings.systemAudio")).not.toBeChecked();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("clears loaded settings when a later open fails to load", async () => {
		vi.mocked(window.electronAPI.getAppSettings)
			.mockResolvedValueOnce(snapshot)
			.mockRejectedValueOnce(new Error("read failed"));
		renderSettings();
		await screen.findByText("appSettings.saveRecording");
		fireEvent.click(screen.getByText("close settings"));
		fireEvent.click(screen.getByText("open settings"));
		expect(await screen.findByRole("alert")).toHaveTextContent("read failed");
		expect(screen.queryByText("appSettings.saveRecording")).not.toBeInTheDocument();
	});

	it("saves the resolved microphone when the stored device has fallen back", async () => {
		vi.mocked(window.electronAPI.getAppSettings).mockResolvedValue({
			...snapshot,
			recording: {
				...recording,
				micEnabled: true,
				micDeviceId: "mic-stale",
				micDeviceName: "Unplugged microphone",
			},
		});
		renderSettings();
		await screen.findByTestId("app-settings-dialog");
		fireEvent.click(screen.getByText("appSettings.saveRecording"));
		await waitFor(() =>
			expect(window.electronAPI.setRecordingPrefs).toHaveBeenCalledWith(
				expect.objectContaining({
					micEnabled: true,
					micDeviceId: "mic-live",
					micDeviceName: "Live microphone",
				}),
			),
		);
	});

	it("does not save while an enabled microphone is still resolving", async () => {
		microphoneHook.isReady = false;
		vi.mocked(window.electronAPI.getAppSettings).mockResolvedValue({
			...snapshot,
			recording: { ...recording, micEnabled: true },
		});
		renderSettings();
		await screen.findByTestId("app-settings-dialog");
		expect(screen.getByText("appSettings.saveRecording").closest("button")).toBeDisabled();
		fireEvent.click(screen.getByText("appSettings.saveRecording"));
		expect(window.electronAPI.setRecordingPrefs).not.toHaveBeenCalled();
	});

	it("keeps an unsaved recording draft when appearance is saved", async () => {
		vi.mocked(window.electronAPI.setProjectAppearanceDefaults).mockImplementation(
			async (defaults) => ({
				recording,
				lastSource: null,
				appearance: { version: 1 as const, custom: true, defaults },
			}),
		);
		renderSettings();
		await screen.findByTestId("app-settings-dialog");
		fireEvent.click(screen.getByLabelText("appSettings.systemAudio"));
		expect(screen.getByLabelText("appSettings.systemAudio")).toBeChecked();
		fireEvent.click(screen.getByText("appSettings.useCurrentAppearance"));
		await waitFor(() => expect(window.electronAPI.setProjectAppearanceDefaults).toHaveBeenCalled());
		expect(screen.getByLabelText("appSettings.systemAudio")).toBeChecked();
		expect(window.electronAPI.setRecordingPrefs).not.toHaveBeenCalled();
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
