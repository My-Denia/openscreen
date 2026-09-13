import type { RecordingSourceDescriptor } from "./app-settings";

export interface LiveRecordingSource {
	id: string;
	name: string;
	display_id: string;
}

export function describeRecordingSource(
	platform: NodeJS.Platform,
	source: LiveRecordingSource,
): RecordingSourceDescriptor {
	return {
		platform,
		kind: source.id.startsWith("window:") ? "window" : "screen",
		id: source.id,
		name: source.name,
		displayId: source.display_id || null,
	};
}

/** Resolves a stored logical descriptor only to an item from a fresh enumeration. */
export function resolveRecordingSource(
	descriptor: RecordingSourceDescriptor | null,
	platform: NodeJS.Platform,
	sources: readonly LiveRecordingSource[],
	options: { waylandPortal?: boolean } = {},
): LiveRecordingSource | null {
	if (!descriptor || descriptor.platform !== platform || options.waylandPortal) return null;
	const kindMatches = sources.filter(
		(source) => (source.id.startsWith("window:") ? "window" : "screen") === descriptor.kind,
	);
	if (descriptor.kind === "window") {
		const exact = kindMatches.filter(
			(source) => source.id === descriptor.id && source.name === descriptor.name,
		);
		return exact.length === 1 ? exact[0] : null;
	}

	if (descriptor.displayId) {
		const stable = kindMatches.filter((source) => source.display_id === descriptor.displayId);
		if (stable.length === 1) return stable[0];
	}
	const exact = kindMatches.filter(
		(source) => source.id === descriptor.id && source.name === descriptor.name,
	);
	return exact.length === 1 ? exact[0] : null;
}
