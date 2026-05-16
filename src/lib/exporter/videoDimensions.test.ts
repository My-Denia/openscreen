import { describe, expect, it } from "vitest";
import { calculateMp4ExportDimensions } from "./videoDimensions";

describe("calculateMp4ExportDimensions", () => {
	it("does not upscale 16:10 recordings above their source bounds for quality presets", () => {
		expect(
			calculateMp4ExportDimensions({
				sourceWidth: 1680,
				sourceHeight: 1050,
				aspectRatio: 16 / 10,
				quality: "good",
			}),
		).toMatchObject({
			width: 1680,
			height: 1050,
		});
	});

	it("keeps 1080p landscape output for a 16:9 source when good quality is selected", () => {
		expect(
			calculateMp4ExportDimensions({
				sourceWidth: 1920,
				sourceHeight: 1080,
				aspectRatio: 16 / 9,
				quality: "good",
			}),
		).toMatchObject({
			width: 1920,
			height: 1080,
		});
	});

	it("preserves source dimensions for the source quality path", () => {
		expect(
			calculateMp4ExportDimensions({
				sourceWidth: 1680,
				sourceHeight: 1050,
				aspectRatio: 16 / 10,
				quality: "source",
			}),
		).toMatchObject({
			width: 1680,
			height: 1050,
		});
	});
});
