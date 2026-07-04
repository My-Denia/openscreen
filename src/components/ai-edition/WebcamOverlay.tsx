// Live webcam preview overlay. Reads the ACTIVE clip's asset `cameraTrack`
// (P4 — the camera link lives per-asset, not on the document, since a
// project can hold multiple recordings each with their own camera or none)
// and drives a real <video> element at the right source-time. The webcam is
// a derived stream — cuts/zoom/speed come from the main timeline. This
// component only reads; it does not write.
//
// ponytail: the camera plays in parallel with the screen. Source-time mapping
//   cameraTime = clip.sourceStartSec + (currentTimeSec − clip.timelineStartSec)
//   adjustment = (cameraTrack.startMs + cameraTrack.offsetMs) / 1000
//   final      = max(0, cameraTime − adjustment)
// (startMs is when the camera comes online; offsetMs is the early/late delay).
// Because this is resolved from the active clip's asset, the overlay
// naturally disappears when the playhead moves onto a clip whose asset has
// no camera, and reappears when it moves onto one that does.

import { useEffect, useMemo, useState } from "react";
import { toFileUrl } from "@/components/video-editor/projectPersistence";
import type { WebcamLayoutPreset, WebcamMaskShape } from "@/components/video-editor/types";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";
import { resolveActiveCameraTrack } from "@/lib/ai-edition/timeline/camera";
import { locateVirtualPosition } from "@/lib/ai-edition/timeline/virtual-preview";
import { getCssClipPath } from "@/lib/webcamMaskShapes";
import styles from "./NewEditorShell.module.css";

interface WebcamOverlayProps {
	clips: AxcutClip[];
	currentTimeSec: number;
	onTimeChange: (sec: number) => void;
	isPlaying: boolean;
	// ponytail: container renders without a frame; the <video> is the only
	// thing the user actually sees. Border radius + clip-path therefore
	// belong on the video so they actually round the camera content.
	borderRadius: number;
	webcamMaskShape: WebcamMaskShape;
	layoutPreset: WebcamLayoutPreset;
}

export function WebcamOverlay(props: WebcamOverlayProps) {
	const { settings } = useEditorSettings();
	const assets = useProjectStore((s) => s.document?.assets ?? null);

	const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
	const [hasError, setHasError] = useState(false);

	const position = useMemo(
		() => locateVirtualPosition(props.clips, props.currentTimeSec),
		[props.clips, props.currentTimeSec],
	);

	const cameraTrack = useMemo(
		() => resolveActiveCameraTrack(assets ?? [], props.clips, props.currentTimeSec),
		[assets, props.clips, props.currentTimeSec],
	);

	const cameraTime = useMemo(() => {
		if (!cameraTrack?.visible || !position) return null;
		const offsetSec = (cameraTrack.startMs + cameraTrack.offsetMs) / 1000;
		return Math.max(0, position.sourceTimeSec - offsetSec);
	}, [cameraTrack, position]);

	// Drive the camera <video> time so its playback matches the main timeline.
	useEffect(() => {
		if (!videoEl) return;
		if (cameraTime === null) return;
		if (Math.abs(videoEl.currentTime - cameraTime) > 0.18) {
			try {
				videoEl.currentTime = cameraTime;
			} catch {
				// ponytail: silent — video not ready yet
			}
		}
	}, [videoEl, cameraTime]);

	// Mirror play/pause with the main preview so the camera stays in sync.
	useEffect(() => {
		if (!videoEl) return;
		if (props.isPlaying) {
			void videoEl.play().catch(() => {
				setHasError(true);
			});
		} else {
			videoEl.pause();
		}
	}, [videoEl, props.isPlaying]);

	if (!cameraTrack?.sourcePath || !cameraTrack.visible) {
		return null;
	}

	const showError = hasError;
	// ponytail: the layout computes the final borderRadius (preset fraction
	// for dual-frame/overlay, 0 for stack, half-circle for circle PiP, etc.).
	// Push it onto the <video> itself so it actually clips the camera
	// content; the container stays a transparent, overflow:hidden wrapper.
	const style: React.CSSProperties = {
		display: showError ? "none" : "block",
		transform: settings.webcamMirrored ? "scaleX(-1)" : undefined,
		clipPath: getCssClipPath(props.webcamMaskShape) ?? undefined,
		borderRadius: `${props.borderRadius}px`,
	};

	return (
		<video
			key={cameraTrack.sourcePath}
			ref={(el) => {
				setVideoEl(el);
				setHasError(false);
			}}
			src={toFileUrl(cameraTrack.sourcePath)}
			className={styles.webcamVideo}
			muted
			playsInline
			preload="metadata"
			onError={() => setHasError(true)}
			onLoadedMetadata={() => {
				if (cameraTime !== null && videoEl && Math.abs(videoEl.currentTime - cameraTime) > 0.18) {
					try {
						videoEl.currentTime = cameraTime;
					} catch {
						// silent
					}
				}
			}}
			style={style}
		/>
	);
}
