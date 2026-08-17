// Shared camera-track resolution (P4 — per-asset media links). A project can
// hold multiple assets, each carrying its own (or no) `cameraTrack`. These
// helpers resolve which camera, if any, applies at a given point on the
// timeline, and whether the timeline has ANY camera at all — used to gate
// camera-only preview chrome and settings controls.

import type { AxcutAsset, AxcutCameraTrack, AxcutClip } from "../schema";
import { locateVirtualPosition } from "./virtual-preview";

export function resolveActiveCameraTrack(
	assets: AxcutAsset[],
	clips: AxcutClip[],
	currentTimeSec: number,
): AxcutCameraTrack | null {
	const position = locateVirtualPosition(clips, currentTimeSec);
	if (!position) return null;
	const activeAsset = assets.find((a) => a.id === position.clip.assetId);
	return activeAsset?.cameraTrack ?? null;
}

/** True when at least one clip currently on the timeline has an asset with a camera attached. */
export function hasAnyClipWithCamera(assets: AxcutAsset[], clips: AxcutClip[]): boolean {
	return clips.some((clip) => assets.find((a) => a.id === clip.assetId)?.cameraTrack != null);
}

/** Clips overlapping `[startSec, endSec)` and how many of those carry a camera. */
export function cameraCoverageUnderSpan(
	assets: AxcutAsset[],
	clips: AxcutClip[],
	startSec: number,
	endSec: number,
): { clips: number; withCamera: number } {
	const lo = Math.min(startSec, endSec);
	const hi = Math.max(startSec, endSec);
	const covered = clips.filter(
		(c) => Math.min(hi, c.timelineEndSec) - Math.max(lo, c.timelineStartSec) > 0,
	);
	return {
		clips: covered.length,
		withCamera: covered.filter(
			(c) => assetCameraSource(assets.find((a) => a.id === c.assetId)).path !== "",
		).length,
	};
}

/** True when the span overlaps at least one clip whose asset has a camera. */
export function hasCameraUnderSpan(
	assets: AxcutAsset[],
	clips: AxcutClip[],
	startSec: number,
	endSec: number,
): boolean {
	return cameraCoverageUnderSpan(assets, clips, startSec, endSec).withCamera > 0;
}

/** Millisecond window `addCameraFullscreen` writes. Shared so the toolbar gate cannot drift. */
export function playheadRegionWindow(
	playheadSec: number,
	durationSec: number,
): { startMs: number; endMs: number; startSec: number; endSec: number } {
	const startMs = Math.round(playheadSec * 1000);
	const endMs = startMs + Math.round(durationSec * 1000);
	return { startMs, endMs, startSec: startMs / 1000, endSec: endMs / 1000 };
}

/** Duration-independent enablement: the first millisecond at the playhead has a camera. */
export function hasCameraAtPlayhead(
	assets: AxcutAsset[],
	clips: AxcutClip[],
	playheadSec: number,
): boolean {
	const { startSec, endSec } = playheadRegionWindow(playheadSec, 0.001);
	return hasCameraUnderSpan(assets, clips, startSec, endSec);
}

/**
 * THE answer to "which camera file does this asset contribute, and where does it
 * start". Every producer of a `CompositorClipInput` — the scene, the preview
 * overlay, the export dialog, the CLI exporter — must go through this, because
 * the native side compares the webcam path against the screen path to decide
 * whether a PiP gets drawn at all (`webcam_is_real`, frame_geometry.rs).
 *
 * `path: ""` is the ONE way to say "no camera". The alternative that used to
 * live in the export producers — substituting `asset.originalPath` — is banned:
 * it makes "no camera" indistinguishable from "the camera happens to be the
 * screen file", and it only ever worked because both fields were filled from
 * the same variable, so the two strings matched byte for byte. Any producer that
 * derived one of them differently (a separator, a case, a resolved vs. raw path
 * — all routine on Windows) would have re-opened issue #265, where the screen
 * recording is drawn into the webcam slot.
 *
 * `visible: false` counts as no camera, matching what the preview and scene
 * already did and what the export producers did NOT.
 */
export function assetCameraSource(asset: AxcutAsset | undefined): {
	path: string;
	offsetSec: number;
} {
	const cam = asset?.cameraTrack;
	if (!cam?.visible || !cam.sourcePath) return { path: "", offsetSec: 0 };
	return { path: cam.sourcePath, offsetSec: (cam.startMs + cam.offsetMs) / 1000 };
}
