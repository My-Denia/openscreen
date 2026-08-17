import { describe, expect, it } from "vitest";
import type { AxcutAsset, AxcutClip } from "../schema";
import {
	assetCameraSource,
	cameraCoverageUnderSpan,
	hasAnyClipWithCamera,
	hasAnyRenderableAsset,
	hasAnyRenderableCamera,
	hasCameraAtPlayhead,
	hasCameraUnderSpan,
	playheadRegionWindow,
	resolveActiveCameraTrack,
} from "./camera";

const assetWithCamera: AxcutAsset = {
	id: "asset_with_camera",
	kind: "video",
	label: "a1",
	originalPath: "/screen-1.mp4",
	cameraTrack: { sourcePath: "/cam-1.mp4", startMs: 0, offsetMs: 0, visible: true },
};

const assetWithHiddenCamera: AxcutAsset = {
	id: "asset_hidden_camera",
	kind: "video",
	label: "a3",
	originalPath: "/screen-3.mp4",
	cameraTrack: { sourcePath: "/cam-3.mp4", startMs: 0, offsetMs: 0, visible: false },
};

const assetWithoutCamera: AxcutAsset = {
	id: "asset_without_camera",
	kind: "video",
	label: "a2",
	originalPath: "/screen-2.mp4",
	cameraTrack: null,
};

const clipWithCamera: AxcutClip = {
	id: "clip_1",
	assetId: "asset_with_camera",
	sourceStartSec: 0,
	sourceEndSec: 5,
	timelineStartSec: 0,
	timelineEndSec: 5,
	wordRefs: [],
	origin: "system",
	reason: "",
};

const clipWithoutCamera: AxcutClip = {
	id: "clip_2",
	assetId: "asset_without_camera",
	sourceStartSec: 0,
	sourceEndSec: 5,
	timelineStartSec: 5,
	timelineEndSec: 10,
	wordRefs: [],
	origin: "system",
	reason: "",
};

describe("resolveActiveCameraTrack", () => {
	it("returns the camera of the asset backing the clip under the playhead", () => {
		const track = resolveActiveCameraTrack(
			[assetWithCamera, assetWithoutCamera],
			[clipWithCamera, clipWithoutCamera],
			2,
		);
		expect(track?.sourcePath).toBe("/cam-1.mp4");
	});

	it("returns null when the active clip's asset has no camera", () => {
		const track = resolveActiveCameraTrack(
			[assetWithCamera, assetWithoutCamera],
			[clipWithCamera, clipWithoutCamera],
			7,
		);
		expect(track).toBeNull();
	});

	it("returns null when there are no clips", () => {
		expect(resolveActiveCameraTrack([assetWithCamera], [], 0)).toBeNull();
	});

	it("returns null when the active clip references an unknown asset", () => {
		const orphanClip: AxcutClip = { ...clipWithCamera, assetId: "missing" };
		expect(resolveActiveCameraTrack([assetWithCamera], [orphanClip], 2)).toBeNull();
	});
});

describe("hasAnyClipWithCamera", () => {
	it("is true when at least one clip's asset has a camera, even if hidden (visible:false)", () => {
		const hiddenClip: AxcutClip = { ...clipWithoutCamera, assetId: "asset_hidden_camera" };
		expect(
			hasAnyClipWithCamera(
				[assetWithHiddenCamera, assetWithoutCamera],
				[hiddenClip, clipWithoutCamera],
			),
		).toBe(true);
	});

	it("is true when at least one clip's asset has a camera", () => {
		expect(
			hasAnyClipWithCamera(
				[assetWithCamera, assetWithoutCamera],
				[clipWithCamera, clipWithoutCamera],
			),
		).toBe(true);
	});

	it("is false when no clip's asset has a camera", () => {
		expect(hasAnyClipWithCamera([assetWithoutCamera], [clipWithoutCamera])).toBe(false);
	});

	it("is false when there are no clips, even if an unused asset has a camera", () => {
		expect(hasAnyClipWithCamera([assetWithCamera], [])).toBe(false);
	});

	it("is false for an empty project", () => {
		expect(hasAnyClipWithCamera([], [])).toBe(false);
	});
});

describe("hasCameraUnderSpan", () => {
	it("is true only for the part of a mixed timeline that actually has a camera", () => {
		const assets = [assetWithCamera, assetWithoutCamera];
		const clips = [clipWithCamera, clipWithoutCamera];
		expect(hasCameraUnderSpan(assets, clips, 0, 2)).toBe(true);
		expect(hasCameraUnderSpan(assets, clips, 6, 8)).toBe(false);
		expect(cameraCoverageUnderSpan(assets, clips, 4, 7)).toEqual({
			clips: 2,
			withCamera: 1,
			withTrack: 1,
		});
	});

	it("is false when the span covers no clip", () => {
		expect(hasCameraUnderSpan([assetWithCamera], [clipWithCamera], 20, 22)).toBe(false);
	});

	it("is false for a hidden camera — preview and export would render nothing", () => {
		const hiddenClip: AxcutClip = { ...clipWithCamera, assetId: "asset_hidden_camera" };
		expect(hasCameraUnderSpan([assetWithHiddenCamera], [hiddenClip], 0, 2)).toBe(false);
		expect(hasCameraAtPlayhead([assetWithHiddenCamera], [hiddenClip], 1)).toBe(false);
		expect(cameraCoverageUnderSpan([assetWithHiddenCamera], [hiddenClip], 0, 2)).toEqual({
			clips: 1,
			withCamera: 0,
			withTrack: 1,
		});
		expect(hasAnyRenderableCamera([assetWithHiddenCamera], [hiddenClip])).toBe(false);
		expect(hasAnyClipWithCamera([assetWithHiddenCamera], [hiddenClip])).toBe(true);
	});
});

describe("hasAnyRenderableAsset", () => {
	it("is true for an unused visible camera, unlike the placed-clip helpers", () => {
		expect(hasAnyRenderableAsset([assetWithCamera])).toBe(true);
		expect(hasAnyRenderableCamera([assetWithCamera], [])).toBe(false);
		expect(hasAnyRenderableAsset([assetWithHiddenCamera])).toBe(false);
		expect(hasAnyRenderableAsset([assetWithoutCamera])).toBe(false);
	});
});

describe("hasCameraAtPlayhead", () => {
	it("does not depend on region duration — only the playhead millisecond", () => {
		const assets = [assetWithCamera, assetWithoutCamera];
		const clips = [clipWithCamera, clipWithoutCamera];
		expect(hasCameraAtPlayhead(assets, clips, 2)).toBe(true);
		expect(hasCameraAtPlayhead(assets, clips, 6)).toBe(false);
		expect(playheadRegionWindow(1.0004, 2).startMs).toBe(1000);
		expect(playheadRegionWindow(1.0004, 2).endMs).toBe(3000);
	});
});

// The single spelling of "no camera". Five producers used to answer this
// question five different ways (empty string, undefined, and — in both export
// paths — the SCREEN recording's own path, which is issue #265's defect shape).
// They all route through assetCameraSource now; this is what pins it.
describe("assetCameraSource", () => {
	it("returns the camera path and its start offset in seconds", () => {
		const asset: AxcutAsset = {
			...assetWithCamera,
			cameraTrack: { sourcePath: "/cam-1.mp4", startMs: 500, offsetMs: -200, visible: true },
		};
		expect(assetCameraSource(asset)).toEqual({ path: "/cam-1.mp4", offsetSec: 0.3 });
	});

	it('says "no camera" with an empty path — NEVER the screen recording', () => {
		expect(assetCameraSource(assetWithoutCamera)).toEqual({ path: "", offsetSec: 0 });
		// The banned fallback: substituting originalPath makes "no camera"
		// indistinguishable from "the camera IS this file", and the native side
		// then has to tell them apart by string comparison.
		expect(assetCameraSource(assetWithoutCamera).path).not.toBe(assetWithoutCamera.originalPath);
	});

	it("treats a hidden camera as no camera", () => {
		// The export producers used to ignore `visible` while the preview and the
		// scene honoured it — the same project rendered two different ways.
		expect(assetCameraSource(assetWithHiddenCamera)).toEqual({ path: "", offsetSec: 0 });
	});

	it("treats a camera track with no source path as no camera", () => {
		// `cameraTrackSchema` requires a non-empty sourcePath, so a parsed document
		// cannot carry this — but the accessor takes an asset, not a parse result,
		// and the branch exists. Covered so it cannot quietly start returning "".
		const asset: AxcutAsset = {
			...assetWithCamera,
			cameraTrack: { sourcePath: "", startMs: 0, offsetMs: 0, visible: true },
		};
		expect(assetCameraSource(asset)).toEqual({ path: "", offsetSec: 0 });
	});

	it("tolerates a missing asset", () => {
		expect(assetCameraSource(undefined)).toEqual({ path: "", offsetSec: 0 });
	});
});
