import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ dialog: { showMessageBox: vi.fn() } }));

import type { BrowserWindow } from "electron";
import { markSheetless, messageBoxOwner } from "./messageBox";

function fakeWindow(destroyed = false) {
	return { isDestroyed: () => destroyed } as unknown as BrowserWindow;
}

describe("messageBoxOwner", () => {
	it("shows a transparent overlay's dialog unowned on macOS, where a sheet greys the whole window", () => {
		const hud = fakeWindow();
		markSheetless(hud);

		expect(messageBoxOwner(hud, "darwin")).toBeNull();
	});

	it("keeps the overlay as owner elsewhere, where an unowned dialog opens behind it", () => {
		const hud = fakeWindow();
		markSheetless(hud);

		expect(messageBoxOwner(hud, "win32")).toBe(hud);
		expect(messageBoxOwner(hud, "linux")).toBe(hud);
	});

	it("keeps an opaque window as owner on macOS", () => {
		const editor = fakeWindow();

		expect(messageBoxOwner(editor, "darwin")).toBe(editor);
	});

	it("never attaches to a missing or destroyed window", () => {
		expect(messageBoxOwner(null, "win32")).toBeNull();
		expect(messageBoxOwner(fakeWindow(true), "win32")).toBeNull();
	});
});
