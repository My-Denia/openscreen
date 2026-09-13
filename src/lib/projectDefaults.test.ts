import { describe, expect, it } from "vitest";
import { createEmptyDocument } from "@/lib/ai-edition/schema";
import { DEFAULT_EDITOR_SETTINGS } from "@/lib/ai-edition/store/editorSettings";
import {
	applyProjectAppearanceDefaults,
	DEFAULT_PROJECT_APPEARANCE,
	parseProjectAppearanceDefaults,
	projectAppearanceFromEditorSettings,
} from "./projectDefaults";

describe("project appearance defaults", () => {
	it("copies the appearance allowlist without media, crop, timing, or identity", () => {
		const source = {
			...DEFAULT_EDITOR_SETTINGS,
			wallpaper: "#123456",
			padding: 12,
			cropRegion: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
			audioGainDb: 9,
		};
		const defaults = projectAppearanceFromEditorSettings(source);
		expect(defaults).toMatchObject({ wallpaper: "#123456", padding: 12 });
		expect(defaults).not.toHaveProperty("cropRegion");
		expect(defaults).not.toHaveProperty("audioGainDb");
		expect(defaults).not.toHaveProperty("assets");
	});

	it("validates the complete payload and rejects partial or unsafe values", () => {
		expect(parseProjectAppearanceDefaults(DEFAULT_PROJECT_APPEARANCE)).toEqual(
			DEFAULT_PROJECT_APPEARANCE,
		);
		expect(() => parseProjectAppearanceDefaults({ padding: 10 })).toThrow(TypeError);
		expect(() =>
			parseProjectAppearanceDefaults({ ...DEFAULT_PROJECT_APPEARANCE, padding: 101 }),
		).toThrow(TypeError);
	});

	it("materializes the allowlist into a new document without changing its identity", () => {
		const empty = createEmptyDocument({ projectId: "proj_defaults", title: "Defaults" });
		const next = applyProjectAppearanceDefaults(empty, {
			...DEFAULT_PROJECT_APPEARANCE,
			wallpaper: "#abcdef",
			padding: 18,
		});
		expect(next.project).toEqual(empty.project);
		expect(next.assets).toEqual([]);
		expect(next.timeline).toEqual(empty.timeline);
		expect(next.legacyEditor).toMatchObject({ wallpaper: "#abcdef", padding: 18 });
	});
});
