import { describe, expect, it } from "vitest";
import { describeRecordingSource, resolveRecordingSource } from "./recording-source-settings";

const display = { id: "screen:1:0", name: "Display 1", display_id: "stable-1" };

describe("recording source settings", () => {
	it("restores a display by stable display id from the fresh list", () => {
		const descriptor = describeRecordingSource("win32", display);
		expect(
			resolveRecordingSource(descriptor, "win32", [
				{ ...display, id: "screen:new-id", name: "Renamed display" },
			]),
		).toMatchObject({ id: "screen:new-id", display_id: "stable-1" });
	});

	it("uses an exact display identity fallback and refuses missing or ambiguous matches", () => {
		const descriptor = describeRecordingSource("win32", display);
		expect(resolveRecordingSource(descriptor, "win32", [display])).toEqual(display);
		expect(resolveRecordingSource(descriptor, "darwin", [display])).toBeNull();
		expect(resolveRecordingSource(descriptor, "win32", [])).toBeNull();
		expect(
			resolveRecordingSource(descriptor, "win32", [{ ...display }, { ...display, id: "screen:2" }]),
		).toEqual(display);
		expect(
			resolveRecordingSource(descriptor, "win32", [{ ...display }, { ...display }]),
		).toBeNull();
	});

	it("requires both live id and name for windows and never guesses by title", () => {
		const saved = describeRecordingSource("win32", {
			id: "window:42",
			name: "Notes",
			display_id: "",
		});
		expect(
			resolveRecordingSource(saved, "win32", [{ id: "window:99", name: "Notes", display_id: "" }]),
		).toBeNull();
		expect(
			resolveRecordingSource(saved, "win32", [{ id: "window:42", name: "Notes", display_id: "" }]),
		).toMatchObject({ id: "window:42" });
	});

	it("never restores a source when the Wayland portal owns selection", () => {
		const descriptor = describeRecordingSource("linux", display);
		expect(
			resolveRecordingSource(descriptor, "linux", [display], { waylandPortal: true }),
		).toBeNull();
		expect(
			resolveRecordingSource(descriptor, "linux", [display], { waylandPortal: false }),
		).toEqual(display);
	});
});
