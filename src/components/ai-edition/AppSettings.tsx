import { Camera, Loader2, Mic, Monitor, MousePointer2, RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { useEditorDialogActions, useEditorDialogSection } from "@/contexts/EditorDialogsContext";
import { useScopedT } from "@/contexts/I18nContext";
import { useCameraDevices } from "@/hooks/useCameraDevices";
import { useMicrophoneDevices } from "@/hooks/useMicrophoneDevices";
import { getEditorSettings } from "@/lib/ai-edition/store/editorSettings";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { projectAppearanceFromEditorSettings } from "@/lib/projectDefaults";
import type { AppSettingsSnapshot, RecordingPreferences } from "../../../electron/app-settings";
import { ModalShell } from "./Modals";
import styles from "./NewEditorShell.module.css";

type Status = "idle" | "loading" | "saving" | "saved" | "error";

function AppSettings({ open, onClose }: { open: boolean; onClose: () => void }) {
	const t = useScopedT("editor");
	const document = useProjectStore((state) => state.document);
	const [snapshot, setSnapshot] = useState<AppSettingsSnapshot | null>(null);
	const [recording, setRecording] = useState<RecordingPreferences | null>(null);
	const [status, setStatus] = useState<Status>("idle");
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		setStatus("loading");
		setError(null);
		void window.electronAPI
			.getAppSettings()
			.then((value) => {
				if (cancelled) return;
				setSnapshot(value);
				setRecording(value.recording);
				setStatus("idle");
			})
			.catch((cause) => {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : String(cause));
				setStatus("error");
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const microphones = useMicrophoneDevices(
		open,
		recording?.micDeviceId ?? undefined,
		recording?.micDeviceName ?? undefined,
	);
	const cameras = useCameraDevices(
		open,
		recording?.camDeviceId ?? undefined,
		recording?.camDeviceName ?? undefined,
	);

	const run = async (work: () => Promise<AppSettingsSnapshot>) => {
		setStatus("saving");
		setError(null);
		try {
			const next = await work();
			setSnapshot(next);
			setRecording(next.recording);
			setStatus("saved");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
			setStatus("error");
		}
	};

	const saveRecording = () => {
		if (!recording) return;
		void run(async () => {
			const saved = await window.electronAPI.setRecordingPrefs(recording);
			const next = await window.electronAPI.getAppSettings();
			return { ...next, recording: saved };
		});
	};
	const editRecording = (patch: Partial<RecordingPreferences>) => {
		setRecording((current) => (current ? { ...current, ...patch } : current));
		setStatus("idle");
		setError(null);
	};

	return (
		<ModalShell
			open={open}
			onClose={onClose}
			title={t("appSettings.title")}
			subtitle={t("appSettings.subtitle")}
			wide
		>
			<div data-testid="app-settings-dialog" style={{ display: "grid", gap: 20 }}>
				{status === "loading" ? (
					<div className={styles.emptyState}>
						<Loader2 size={18} className="animate-spin" /> {t("appSettings.loading")}
					</div>
				) : recording && snapshot ? (
					<>
						<section style={{ display: "grid", gap: 10 }}>
							<h3>
								<Monitor size={16} /> {t("appSettings.recordingTitle")}
							</h3>
							<SettingToggle
								label={t("appSettings.systemAudio")}
								checked={recording.systemAudioEnabled}
								onChange={(value) => editRecording({ systemAudioEnabled: value })}
							/>
							<SettingToggle
								label={t("appSettings.microphone")}
								checked={recording.micEnabled}
								onChange={(value) => editRecording({ micEnabled: value })}
							/>
							<label className={styles.field}>
								<span>
									<Mic size={14} /> {t("appSettings.microphoneDevice")}
								</span>
								<select
									value={microphones.selectedDeviceId}
									onChange={(event) => {
										const device = microphones.devices.find(
											(item) => item.deviceId === event.target.value,
										);
										if (!device) return;
										microphones.setSelectedDeviceId(device.deviceId);
										editRecording({
											micDeviceId: device.deviceId,
											micDeviceName: device.label,
										});
									}}
								>
									{microphones.devices.map((device) => (
										<option key={device.deviceId} value={device.deviceId}>
											{device.label}
										</option>
									))}
								</select>
							</label>
							<SettingToggle
								label={t("appSettings.camera")}
								checked={recording.camEnabled}
								onChange={(value) => editRecording({ camEnabled: value })}
							/>
							<label className={styles.field}>
								<span>
									<Camera size={14} /> {t("appSettings.cameraDevice")}
								</span>
								<select
									value={cameras.selectedDeviceId}
									onChange={(event) => {
										const device = cameras.devices.find(
											(item) => item.deviceId === event.target.value,
										);
										if (!device) return;
										cameras.setSelectedDeviceId(device.deviceId);
										editRecording({
											camDeviceId: device.deviceId,
											camDeviceName: device.label,
										});
									}}
								>
									{cameras.devices.map((device) => (
										<option key={device.deviceId} value={device.deviceId}>
											{device.label}
										</option>
									))}
								</select>
							</label>
							<SettingToggle
								label={t("appSettings.editableCursor")}
								checked={recording.cursorCaptureMode === "editable-overlay"}
								onChange={(value) =>
									editRecording({
										cursorCaptureMode: value ? "editable-overlay" : "system",
									})
								}
							/>
							<SettingToggle
								label={t("appSettings.autoZoom")}
								checked={recording.autoZoomEnabled}
								disabled={recording.cursorCaptureMode === "system"}
								onChange={(value) => editRecording({ autoZoomEnabled: value })}
							/>
							<p>
								{t("appSettings.lastSource", {
									source: snapshot.lastSource?.name ?? t("appSettings.noSource"),
								})}
							</p>
							<div className={styles.actions}>
								<button
									type="button"
									className={`${styles.btn} ${styles.btnPrimary}`}
									onClick={saveRecording}
									disabled={status === "saving"}
								>
									<Save size={14} /> {t("appSettings.saveRecording")}
								</button>
								<button
									type="button"
									className={styles.btn}
									onClick={() => void run(() => window.electronAPI.resetRecordingSetup())}
									disabled={status === "saving"}
								>
									<RotateCcw size={14} /> {t("appSettings.resetRecording")}
								</button>
							</div>
						</section>
						<section style={{ display: "grid", gap: 10 }}>
							<h3>
								<MousePointer2 size={16} /> {t("appSettings.appearanceTitle")}
							</h3>
							<p>
								{snapshot.appearance.custom
									? t("appSettings.customAppearance")
									: t("appSettings.factoryAppearance")}
							</p>
							<p data-testid="appearance-defaults-summary">
								{t("appSettings.appearanceSummary", {
									aspect: snapshot.appearance.defaults.aspectRatio,
									padding: snapshot.appearance.defaults.padding,
									radius: snapshot.appearance.defaults.borderRadius,
									cursor: snapshot.appearance.defaults.cursorTheme,
									camera: snapshot.appearance.defaults.webcamLayoutPreset,
								})}
							</p>
							<div className={styles.actions}>
								<button
									type="button"
									className={`${styles.btn} ${styles.btnPrimary}`}
									disabled={!document || status === "saving"}
									onClick={() => {
										if (!document) return;
										const defaults = projectAppearanceFromEditorSettings(
											getEditorSettings(document),
										);
										void run(() => window.electronAPI.setProjectAppearanceDefaults(defaults));
									}}
								>
									{t("appSettings.useCurrentAppearance")}
								</button>
								<button
									type="button"
									className={styles.btn}
									onClick={() =>
										void run(() => window.electronAPI.resetProjectAppearanceDefaults())
									}
									disabled={status === "saving"}
								>
									<RotateCcw size={14} /> {t("appSettings.resetAppearance")}
								</button>
							</div>
						</section>
					</>
				) : null}
				{status === "saved" ? <p role="status">{t("appSettings.saved")}</p> : null}
				{error ? <p role="alert">{t("appSettings.saveFailed", { error })}</p> : null}
			</div>
		</ModalShell>
	);
}

function SettingToggle({
	label,
	checked,
	disabled,
	onChange,
}: {
	label: string;
	checked: boolean;
	disabled?: boolean;
	onChange: (value: boolean) => void;
}) {
	return (
		<label
			style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}
		>
			<span>{label}</span>
			<input
				type="checkbox"
				checked={checked}
				disabled={disabled}
				onChange={(event) => onChange(event.target.checked)}
			/>
		</label>
	);
}

export function AppSettingsDialog() {
	const section = useEditorDialogSection();
	const { closeDialog } = useEditorDialogActions();
	return <AppSettings open={section === "settings"} onClose={closeDialog} />;
}
