import type { ExportQuality } from "./types";

interface Mp4ExportDimensionsParams {
	sourceWidth: number;
	sourceHeight: number;
	aspectRatio: number;
	quality: ExportQuality;
}

export interface Mp4ExportDimensions {
	width: number;
	height: number;
	bitrate: number;
}

function toEven(value: number) {
	return Math.max(2, Math.floor(value / 2) * 2);
}

function getBitrate(width: number, height: number) {
	const totalPixels = width * height;
	if (totalPixels <= 1280 * 720) {
		return 10_000_000;
	}
	if (totalPixels <= 1920 * 1080) {
		return 20_000_000;
	}
	if (totalPixels <= 2560 * 1440) {
		return 50_000_000;
	}
	return 80_000_000;
}

function getSourceQualityBitrate(width: number, height: number) {
	const totalPixels = width * height;
	if (totalPixels > 2560 * 1440) {
		return 80_000_000;
	}
	if (totalPixels > 1920 * 1080) {
		return 50_000_000;
	}
	return 30_000_000;
}

function calculateSourceQualityDimensions(
	sourceWidth: number,
	sourceHeight: number,
	aspectRatio: number,
) {
	if (aspectRatio === 1) {
		const baseDimension = toEven(Math.min(sourceWidth, sourceHeight));
		return { width: baseDimension, height: baseDimension };
	}

	const sourceLongDim = Math.max(sourceWidth, sourceHeight);

	if (aspectRatio > 1) {
		const baseWidth = toEven(sourceLongDim);
		for (let width = baseWidth; width >= 100; width -= 2) {
			const height = Math.round(width / aspectRatio);
			if (height % 2 === 0 && Math.abs(width / height - aspectRatio) < 0.0001) {
				return { width, height };
			}
		}
		return { width: baseWidth, height: toEven(baseWidth / aspectRatio) };
	}

	const baseHeight = toEven(sourceLongDim);
	for (let height = baseHeight; height >= 100; height -= 2) {
		const width = Math.round(height * aspectRatio);
		if (width % 2 === 0 && Math.abs(width / height - aspectRatio) < 0.0001) {
			return { width, height };
		}
	}
	return { width: toEven(baseHeight * aspectRatio), height: baseHeight };
}

function getMaxDimensionsWithinSourceBounds(
	sourceWidth: number,
	sourceHeight: number,
	aspectRatio: number,
) {
	const sourceAspect = sourceWidth / sourceHeight;

	if (aspectRatio >= sourceAspect) {
		const width = toEven(sourceWidth);
		return { width, height: toEven(width / aspectRatio) };
	}

	const height = toEven(sourceHeight);
	return { width: toEven(height * aspectRatio), height };
}

export function calculateMp4ExportDimensions({
	sourceWidth,
	sourceHeight,
	aspectRatio,
	quality,
}: Mp4ExportDimensionsParams): Mp4ExportDimensions {
	const safeAspectRatio =
		Number.isFinite(aspectRatio) && aspectRatio > 0 ? aspectRatio : sourceWidth / sourceHeight;

	if (quality === "source") {
		const dimensions = calculateSourceQualityDimensions(sourceWidth, sourceHeight, safeAspectRatio);
		return { ...dimensions, bitrate: getSourceQualityBitrate(dimensions.width, dimensions.height) };
	}

	const targetShortDim = quality === "medium" ? 720 : 1080;
	const maxDimensions = getMaxDimensionsWithinSourceBounds(
		sourceWidth,
		sourceHeight,
		safeAspectRatio,
	);
	const maxShortDim = Math.min(maxDimensions.width, maxDimensions.height);
	const exportShortDim = Math.min(targetShortDim, maxShortDim);

	const dimensions =
		safeAspectRatio >= 1
			? {
					height: toEven(exportShortDim),
					width: toEven(exportShortDim * safeAspectRatio),
				}
			: {
					width: toEven(exportShortDim),
					height: toEven(exportShortDim / safeAspectRatio),
				};

	return { ...dimensions, bitrate: getBitrate(dimensions.width, dimensions.height) };
}
