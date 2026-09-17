/**
 * The frame drawn around the recording, a project setting like the wallpaper. "none" draws
 * nothing and renders exactly as before the setting existed.
 *
 * Two families, and the difference is not cosmetic: the window chrome is drawn FLAT in the
 * screen's own plane (shader mode 14), while the four devices are modelled in real 3D around it
 * (mode 17) — a body with thickness, a bevel and a bezel, ray-marched in the same camera as the
 * footage. Which is why the camera can move around them.
 */
export type RecordingFrame =
	| "none"
	| "window-light"
	| "window-dark"
	| "browser"
	| "laptop"
	| "phone"
	| "monitor";

export const RECORDING_FRAMES = [
	"none",
	"window-light",
	"window-dark",
	"browser",
	"laptop",
	"phone",
	"monitor",
] as const satisfies readonly RecordingFrame[];

/**
 * The devices modelled in 3D, in menu order. They are the values that shader mode 17 draws;
 * everything else is flat.
 */
export const DEVICE_FRAMES = [
	"browser",
	"laptop",
	"phone",
	"monitor",
] as const satisfies readonly RecordingFrame[];

export function isRecordingFrame(value: unknown): value is RecordingFrame {
	return typeof value === "string" && (RECORDING_FRAMES as readonly string[]).includes(value);
}

/**
 * The phone is the only PORTRAIT device: wrapped around a landscape recording it would read as a
 * phone held sideways with its screen stretched across, which is not a thing. The picker offers
 * it only when the output is at least as tall as it is wide, and says so when it does not.
 *
 * `null` = the frame is offered. A string = the reason it is not, as an i18n key.
 */
export function recordingFrameBlockedReason(
	frame: RecordingFrame,
	outputAspect: number,
): string | null {
	return frame === "phone" && outputAspect > 1 ? "effects.frameNeedsPortrait" : null;
}

export interface ProjectAppearanceDefaults {
	wallpaper: string;
	wallpaperMotion: "none" | "drift" | "aurora" | "waves";
	frame: RecordingFrame;
	aspectRatio: `${number}:${number}` | "native";
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
	/** Defocus a 3D-tilted screen by its depth; inert on flat zooms. */
	depthOfField: boolean;
	borderRadius: number;
	padding: number;
	webcamLayoutPreset: "picture-in-picture" | "vertical-stack" | "dual-frame" | "no-webcam";
	webcamMaskShape: "rectangle" | "circle" | "square" | "rounded";
	webcamMirrored: boolean;
	webcamReactiveZoom: boolean;
	webcamSizePreset: number;
	webcamPosition: { cx: number; cy: number } | null;
	webcamBackgroundMode: "none" | "transparent" | "blur" | "custom";
	webcamWallpaper: string;
	webcamBlurIntensity: number;
	cursor: {
		size: number;
		smoothing: number;
		motionBlur: number;
		clickBounce: number;
		model3d: boolean;
		clipToBounds: boolean;
		autoHide: boolean;
	};
	cursorShow: boolean;
	cursorAutoHide: boolean;
	cursorTheme: string;
	autoFocusAll: boolean;
}

/** The factory appearance every new project starts from. */
export const DEFAULT_PROJECT_APPEARANCE: ProjectAppearanceDefaults = {
	wallpaper: "/wallpapers/wallpaper1.jpg",
	wallpaperMotion: "none",
	frame: "none",
	aspectRatio: "16:9",
	shadowIntensity: 0.2,
	showBlur: false,
	motionBlurAmount: 0.2,
	// On: it only acts on tilted zooms, where the blur already scales with the real angle.
	depthOfField: true,
	borderRadius: 40,
	padding: 50,
	webcamLayoutPreset: "picture-in-picture",
	webcamMaskShape: "rectangle",
	webcamMirrored: false,
	webcamReactiveZoom: true,
	webcamSizePreset: 25,
	webcamPosition: null,
	webcamBackgroundMode: "none",
	webcamWallpaper: "/wallpapers/wallpaper1.jpg",
	webcamBlurIntensity: 0.5,
	cursor: {
		size: 3,
		smoothing: 0.67,
		motionBlur: 0.35,
		clickBounce: 2.5,
		model3d: false,
		clipToBounds: false,
		autoHide: false,
	},
	cursorShow: true,
	cursorAutoHide: false,
	cursorTheme: "default",
	autoFocusAll: false,
};
