// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ZOOM_DEPTH_SCALES, type ZoomDepth } from "@/components/video-editor/types";

// The pane is only reachable with a project open and a zoom region selected, so drive the
// control directly. The translator echoes keys, as in `SpeedControl.test.tsx`.
vi.mock("@/contexts/I18nContext", () => ({
	useScopedT: () => (key: string) => key,
}));

import { ZoomLevelControl } from "./FloatingInspector";

function renderControl(depth: ZoomDepth) {
	const updateZoomDepth = vi.fn(async () => {
		// the control only awaits the promise, never its value
	});
	render(<ZoomLevelControl region={{ id: "z1", depth }} tl={{ updateZoomDepth }} />);
	const group = screen.getByRole("group", { name: "zoom.level" });
	const buttons = screen.getAllByRole("button");
	return { updateZoomDepth, group, buttons };
}

describe("ZoomLevelControl", () => {
	it("renders one button per depth, labelled with the table value, current one pressed", () => {
		const { buttons } = renderControl(3);
		expect(buttons).toHaveLength(6);
		expect(buttons.map((b) => b.textContent)).toEqual(
			([1, 2, 3, 4, 5, 6] as const).map((d) => `${ZOOM_DEPTH_SCALES[d]}×`),
		);
		expect(buttons.map((b) => b.getAttribute("aria-pressed"))).toEqual([
			"false",
			"false",
			"true",
			"false",
			"false",
			"false",
		]);
	});

	it("commits a level in one click", () => {
		const { updateZoomDepth, buttons } = renderControl(3);
		fireEvent.click(buttons[4] as HTMLButtonElement);
		expect(updateZoomDepth).toHaveBeenCalledTimes(1);
		expect(updateZoomDepth).toHaveBeenCalledWith("z1", 5);
	});

	it("does not write when the current level is clicked again", () => {
		// A no-op edit would still land a save and an undo entry.
		const { updateZoomDepth, buttons } = renderControl(3);
		fireEvent.click(buttons[2] as HTMLButtonElement);
		expect(updateZoomDepth).not.toHaveBeenCalled();
	});

	it("steps to the neighbouring level with the arrow keys and moves focus with it", () => {
		const { updateZoomDepth, group, buttons } = renderControl(3);
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 4);
		expect(buttons[3]).toHaveFocus();
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 2);
		expect(buttons[1]).toHaveFocus();
		fireEvent.keyDown(group, { key: "ArrowDown" });
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 4);
		fireEvent.keyDown(group, { key: "ArrowUp" });
		expect(updateZoomDepth).toHaveBeenLastCalledWith("z1", 2);
		expect(updateZoomDepth).toHaveBeenCalledTimes(4);
	});

	it("clamps at the lowest level instead of wrapping", () => {
		const { updateZoomDepth, group } = renderControl(1);
		fireEvent.keyDown(group, { key: "ArrowLeft" });
		expect(updateZoomDepth).not.toHaveBeenCalled();
	});

	it("clamps at the highest level instead of wrapping", () => {
		const { updateZoomDepth, group } = renderControl(6);
		fireEvent.keyDown(group, { key: "ArrowRight" });
		expect(updateZoomDepth).not.toHaveBeenCalled();
	});

	it("stops the arrow keys reaching the window listener, and nothing else", () => {
		// ArrowLeft/ArrowRight seek the playhead on WINDOW, above React's root container.
		// Stopping only the synthetic event would change the level and nudge the playhead in
		// the same keystroke.
		const onWindowKey = vi.fn();
		window.addEventListener("keydown", onWindowKey);
		try {
			const { group } = renderControl(3);
			for (const key of ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]) {
				fireEvent.keyDown(group, { key });
			}
			expect(onWindowKey).not.toHaveBeenCalled();

			// Keys the group ignores still get there, or the editor shortcuts would be dead.
			fireEvent.keyDown(group, { key: "z" });
			fireEvent.keyDown(group, { key: "Tab" });
			expect(onWindowKey).toHaveBeenCalledTimes(2);
		} finally {
			window.removeEventListener("keydown", onWindowKey);
		}
	});
});
