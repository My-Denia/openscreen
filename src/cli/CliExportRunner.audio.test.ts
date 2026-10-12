import { describe, expect, it } from "vitest";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { axcutSchemaVersion } from "@/lib/ai-edition/schema";
import { buildNativeClipList } from "./CliExportRunner";

const document: AxcutDocument = {
	schemaVersion: axcutSchemaVersion,
	project: {
		id: "project",
		title: "Audio mute",
		createdAt: "2026-10-12T00:00:00.000Z",
		updatedAt: "2026-10-12T00:00:00.000Z",
		primaryAssetId: "recording",
	},
	assets: [
		{
			id: "recording",
			kind: "video",
			label: "recording.mp4",
			originalPath: "/tmp/recording.mp4",
			cameraTrack: null,
			durationSec: 4,
			video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
		},
	],
	transcript: null,
	timeline: {
		clips: [
			{
				id: "clip",
				assetId: "recording",
				sourceStartSec: 0,
				sourceEndSec: 4,
				timelineStartSec: 0,
				timelineEndSec: 4,
				wordRefs: [],
				origin: "user",
				reason: "",
			},
		],
		gaps: [],
		trimRanges: [],
		muteRanges: [],
		speedRanges: [],
		captionRanges: [],
	},
	annotations: [],
	zoomRanges: [],
	audioTracks: [],
	transcripts: [],
	legacyEditor: null,
};

describe("CLI recording audio mute", () => {
	it("keeps clip audio by default and disables it only for a muted project", () => {
		expect(buildNativeClipList(document)[0]?.hasAudio).toBe(true);
		expect(
			buildNativeClipList({
				...document,
				legacyEditor: { recordingAudioMuted: true },
			})[0]?.hasAudio,
		).toBe(false);
	});
});
