// @vitest-environment jsdom
import "@testing-library/jest-dom";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { EditClipModal } from "./Modals";

function renderWithI18n(ui: ReactElement) {
	return render(<I18nProvider>{ui}</I18nProvider>);
}

const trimmedClip: AxcutClip = {
	id: "clip_1",
	assetId: "asset_1",
	sourceStartSec: 20,
	sourceEndSec: 105,
	timelineStartSec: 0,
	timelineEndSec: 85,
	wordRefs: [],
	origin: "user",
	reason: "",
};

function renderModal(clip: AxcutClip = trimmedClip, durationSec: number | null = 155) {
	return renderWithI18n(
		<EditClipModal
			open={true}
			onClose={vi.fn()}
			clip={clip}
			assetMeta={{
				label: "Recording",
				...(durationSec == null ? {} : { durationSec }),
			}}
			videoSources={[]}
			onApply={vi.fn()}
		/>,
	);
}

describe("EditClipModal trim duration readout", () => {
	afterEach(() => {
		cleanup();
		vi.clearAllMocks();
	});

	it("labels original duration, trim range, and final duration", () => {
		renderModal();

		expect(screen.getByText("Original duration")).toBeInTheDocument();
		expect(screen.getByText("Trim range")).toBeInTheDocument();
		expect(screen.getByText("Final duration")).toBeInTheDocument();
		expect(screen.queryByText("Duration")).not.toBeInTheDocument();
	});

	it("shows source length, the start–end range, and end-minus-start", () => {
		renderModal();

		expect(screen.getByText("Original duration").previousElementSibling).toHaveTextContent(
			"2:35.0",
		);
		expect(screen.getByText("Trim range").previousElementSibling).toHaveTextContent(
			"0:20.0–1:45.0",
		);
		expect(screen.getByText("Final duration").previousElementSibling).toHaveTextContent("1:25.0");
	});

	it("does not label the trim out-point as original duration when asset length is missing", () => {
		renderModal(trimmedClip, null);

		// An em dash, the same placeholder `formatBytes` prints for an absent
		// `sizeBytes` — not a duration, so it cannot be mistaken for one.
		expect(screen.getByText("Original duration").previousElementSibling).toHaveTextContent("—");
		expect(screen.getByText("Original duration").previousElementSibling).not.toHaveTextContent(
			"1:45.0",
		);
		expect(screen.getByText("Trim range").previousElementSibling).toHaveTextContent(
			"0:20.0–1:45.0",
		);
		expect(screen.getByText("Final duration").previousElementSibling).toHaveTextContent("1:25.0");
	});
});
