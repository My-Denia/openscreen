import { describe, expect, it } from "vitest";
import { PLACEHOLDER_DURATION_SEC } from "@/lib/ai-edition/document/timeline";
import { type AxcutDocument, axcutSchemaVersion } from "@/lib/ai-edition/schema";
import {
	documentAfterLoadedMetadata,
	isLoadedMetadataForDocument,
} from "./loadedRecordingMetadata";

function emptyRecordingDoc(projectId = "proj_fresh"): AxcutDocument {
	return {
		schemaVersion: axcutSchemaVersion,
		project: {
			id: projectId,
			title: "Recording",
			createdAt: "2026-06-26T10:00:00Z",
			updatedAt: "2026-06-26T10:00:00Z",
			primaryAssetId: "asset_1",
		},
		assets: [
			{
				id: "asset_1",
				kind: "video",
				label: "screen.webm",
				originalPath: "/tmp/screen.webm",
				cameraTrack: null,
			},
		],
		transcript: null,
		transcripts: [],
		timeline: {
			clips: [],
			gaps: [],
			trimRanges: [],
			muteRanges: [],
			speedRanges: [],
			captionRanges: [],
		},
		annotations: [],
		zoomRanges: [],
		audioTracks: [],
		legacyEditor: null,
	};
}

describe("documentAfterLoadedMetadata", () => {
	it("seeds an empty timeline from a finite probe and writes it on the asset", () => {
		const doc = emptyRecordingDoc();
		const next = documentAfterLoadedMetadata(doc, 12.5, "asset_1");
		expect(next.timeline.clips).toHaveLength(1);
		expect(next.timeline.clips[0].sourceStartSec).toBe(0);
		expect(next.timeline.clips[0].sourceEndSec).toBe(12.5);
		expect(next.assets[0].durationSec).toBe(12.5);
	});

	it("keeps a 60s fallback clip when metadata is non-finite without treating 60 as probed", () => {
		const doc = emptyRecordingDoc();
		for (const durationSec of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1]) {
			const next = documentAfterLoadedMetadata(doc, durationSec, "asset_1");
			expect(next.timeline.clips).toHaveLength(1);
			expect(next.timeline.clips[0].sourceEndSec).toBe(PLACEHOLDER_DURATION_SEC);
			expect(next.assets[0].durationSec).toBeUndefined();
		}
	});

	it("does not stamp a leftover 60s onto an existing timeline when metadata is still unusable", () => {
		const seeded = documentAfterLoadedMetadata(emptyRecordingDoc(), Number.NaN, "asset_1");
		expect(documentAfterLoadedMetadata(seeded, Number.NaN, "asset_1")).toBe(seeded);
	});

	it("replaces a fallback clip once a real duration arrives", () => {
		const seeded = documentAfterLoadedMetadata(emptyRecordingDoc(), Number.NaN, "asset_1");
		const next = documentAfterLoadedMetadata(seeded, 8, "asset_1");
		expect(next.timeline.clips[0].sourceEndSec).toBe(8);
		expect(next.assets[0].durationSec).toBe(8);
	});
});

describe("isLoadedMetadataForDocument", () => {
	it("rejects a queued duration after the user switched projects", () => {
		const doc = emptyRecordingDoc("proj_b");
		expect(isLoadedMetadataForDocument(doc, "proj_a")).toBe(false);
		expect(isLoadedMetadataForDocument(null, "proj_a")).toBe(false);
		expect(isLoadedMetadataForDocument(doc, "proj_b")).toBe(true);
	});
});
