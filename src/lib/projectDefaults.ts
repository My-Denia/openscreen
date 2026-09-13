import type { AxcutDocument } from "./ai-edition/schema";

export interface ProjectAppearanceDefaults {
	wallpaper: string;
	aspectRatio: `${number}:${number}` | "native";
	shadowIntensity: number;
	showBlur: boolean;
	motionBlurAmount: number;
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
		clipToBounds: boolean;
	};
	cursorShow: boolean;
	cursorTheme: string;
	autoFocusAll: boolean;
}

/** Structural input accepted from the editor settings reader without coupling this
 * main-process-safe serializer to renderer-only modules or path aliases. */
export type ProjectAppearanceSource = ProjectAppearanceDefaults;

export const DEFAULT_PROJECT_APPEARANCE: ProjectAppearanceDefaults = {
	wallpaper: "/wallpapers/wallpaper1.jpg",
	aspectRatio: "16:9",
	shadowIntensity: 0.2,
	showBlur: false,
	motionBlurAmount: 0.2,
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
		clipToBounds: false,
	},
	cursorShow: true,
	cursorTheme: "default",
	autoFocusAll: false,
};

const LAYOUTS = new Set(["picture-in-picture", "vertical-stack", "dual-frame", "no-webcam"]);
const MASK_SHAPES = new Set(["rectangle", "circle", "square", "rounded"]);
const BACKGROUND_MODES = new Set(["none", "transparent", "blur", "custom"]);

function finite(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function isAspectRatio(value: unknown): value is string {
	if (value === "native") return true;
	if (typeof value !== "string") return false;
	const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
	return Boolean(match && Number(match[1]) > 0 && Number(match[2]) > 0);
}

function position(value: unknown): value is ProjectAppearanceDefaults["webcamPosition"] {
	if (value === null) return true;
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return finite(candidate.cx, 0, 1) && finite(candidate.cy, 0, 1);
}

function cursor(value: unknown): value is ProjectAppearanceDefaults["cursor"] {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		finite(candidate.size, 0.1, 20) &&
		finite(candidate.smoothing, 0, 1) &&
		finite(candidate.motionBlur, 0, 1) &&
		finite(candidate.clickBounce, 0, 10) &&
		typeof candidate.clipToBounds === "boolean"
	);
}

export function projectAppearanceFromEditorSettings(
	settings: ProjectAppearanceSource,
): ProjectAppearanceDefaults {
	return {
		wallpaper: settings.wallpaper,
		aspectRatio: settings.aspectRatio,
		shadowIntensity: settings.shadowIntensity,
		showBlur: settings.showBlur,
		motionBlurAmount: settings.motionBlurAmount,
		borderRadius: settings.borderRadius,
		padding: settings.padding,
		webcamLayoutPreset: settings.webcamLayoutPreset,
		webcamMaskShape: settings.webcamMaskShape,
		webcamMirrored: settings.webcamMirrored,
		webcamReactiveZoom: settings.webcamReactiveZoom,
		webcamSizePreset: settings.webcamSizePreset,
		webcamPosition: settings.webcamPosition ? { ...settings.webcamPosition } : null,
		webcamBackgroundMode: settings.webcamBackgroundMode,
		webcamWallpaper: settings.webcamWallpaper,
		webcamBlurIntensity: settings.webcamBlurIntensity,
		cursor: { ...settings.cursor },
		cursorShow: settings.cursorShow,
		cursorTheme: settings.cursorTheme,
		autoFocusAll: settings.autoFocusAll,
	};
}

export function parseProjectAppearanceDefaults(value: unknown): ProjectAppearanceDefaults {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("project appearance defaults must be an object");
	}
	const candidate = value as Record<string, unknown>;
	if (
		typeof candidate.wallpaper !== "string" ||
		!isAspectRatio(candidate.aspectRatio) ||
		!finite(candidate.shadowIntensity, 0, 1) ||
		typeof candidate.showBlur !== "boolean" ||
		!finite(candidate.motionBlurAmount, 0, 1) ||
		!finite(candidate.borderRadius, 0, 500) ||
		!finite(candidate.padding, 0, 100) ||
		!LAYOUTS.has(candidate.webcamLayoutPreset as string) ||
		!MASK_SHAPES.has(candidate.webcamMaskShape as string) ||
		typeof candidate.webcamMirrored !== "boolean" ||
		typeof candidate.webcamReactiveZoom !== "boolean" ||
		!finite(candidate.webcamSizePreset, 10, 50) ||
		!position(candidate.webcamPosition) ||
		!BACKGROUND_MODES.has(candidate.webcamBackgroundMode as string) ||
		typeof candidate.webcamWallpaper !== "string" ||
		!finite(candidate.webcamBlurIntensity, 0, 1) ||
		!cursor(candidate.cursor) ||
		typeof candidate.cursorShow !== "boolean" ||
		typeof candidate.cursorTheme !== "string" ||
		candidate.cursorTheme.length === 0 ||
		typeof candidate.autoFocusAll !== "boolean"
	) {
		throw new TypeError("project appearance defaults are invalid");
	}
	return projectAppearanceFromEditorSettings(candidate as unknown as ProjectAppearanceSource);
}

export function applyProjectAppearanceDefaults(
	document: AxcutDocument,
	defaults: ProjectAppearanceDefaults,
): AxcutDocument {
	const parsed = parseProjectAppearanceDefaults(defaults);
	return {
		...document,
		legacyEditor: {
			...(document.legacyEditor ?? {}),
			wallpaper: parsed.wallpaper,
			aspectRatio: parsed.aspectRatio,
			shadowIntensity: parsed.shadowIntensity,
			showBlur: parsed.showBlur,
			motionBlurAmount: parsed.motionBlurAmount,
			borderRadius: parsed.borderRadius,
			padding: parsed.padding,
			webcamLayoutPreset: parsed.webcamLayoutPreset,
			webcamMaskShape: parsed.webcamMaskShape,
			webcamMirrored: parsed.webcamMirrored,
			webcamReactiveZoom: parsed.webcamReactiveZoom,
			webcamSizePreset: parsed.webcamSizePreset,
			webcamPosition: parsed.webcamPosition,
			webcamBackgroundMode: parsed.webcamBackgroundMode,
			webcamWallpaper: parsed.webcamWallpaper,
			webcamBlurIntensity: parsed.webcamBlurIntensity,
			cursorSize: parsed.cursor.size,
			cursorSmoothing: parsed.cursor.smoothing,
			cursorMotionBlur: parsed.cursor.motionBlur,
			cursorClickBounce: parsed.cursor.clickBounce,
			cursorClipToBounds: parsed.cursor.clipToBounds,
			cursorShow: parsed.cursorShow,
			cursorTheme: parsed.cursorTheme,
			autoFocusAll: parsed.autoFocusAll,
		},
	};
}
