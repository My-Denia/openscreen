import type { TrimRegion } from "@/components/video-editor/types";
import type { SttWordSegment } from "../../../electron/stt/transcriptionContract";

export interface CaptionSegment {
	startSec: number;
	endSec: number;
	text: string;
}

/**
 * How caption layout should interpret `CaptionSegment` times from
 * `transcribeMono16kToSegments`. The native pipeline always emits per-word
 * timestamps (forced alignment over whisper phrases), so the only value here
 * is `"word"`.
 */
export type CaptionTimestampGranularity = "word" | "phrase";

export interface TranscribeMono16kResult {
	segments: CaptionSegment[];
	granularity: CaptionTimestampGranularity;
	/**
	 * ISO 639-1 code Whisper settled on for the chunk stream — either the
	 * forced one (when `language` was supplied) or what it auto-detected.
	 * Null when the model produced no language token.
	 */
	detectedLanguage?: string | null;
}

export type SttRendererStatusPhase = "model" | "transcribe";

interface RendererSttApi {
	transcribe: (request: { samples: Float32Array; language?: string }) => Promise<{
		segments: CaptionSegment[];
		wordSegments: SttWordSegment[];
		detectedLanguage: string;
		backend: string;
	}>;
	onStatus?: (callback: (event: { phase: SttRendererStatusPhase }) => void) => () => void;
}

/**
 * Transcribes mono 16 kHz audio into per-word timed caption segments. The
 * renderer is a thin IPC adapter: it forwards the audio to the Electron main
 * process where `whisper-server` + `onnxruntime-node` forced alignment run.
 *
 * The previous in-Web-Worker implementation (Transformers.js + ORT-WASM) was
 * 0.5× realtime on tiny models and had no word-level accuracy under 50 ms;
 * see `docs/engineering/transcription-engine-migration.md` for context.
 */
export function transcribeMono16kToSegments(
	samples: Float32Array,
	options?: {
		trimRegions?: TrimRegion[];
		onStatus?: (phase: SttRendererStatusPhase) => void;
		signal?: AbortSignal;
		language?: string;
	},
): Promise<TranscribeMono16kResult> {
	if (options?.signal?.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}
	const api = (window as Window & { electronAPI?: { stt?: RendererSttApi } }).electronAPI?.stt;
	if (!api?.transcribe) {
		// Renderer-only fallback (browser tests, dev tooling without Electron).
		// We don't try to run any model here — the worker migration is permanent.
		return Promise.resolve({ segments: [], granularity: "word" });
	}

	const unsubscribe =
		options?.onStatus && api.onStatus?.((event) => options.onStatus?.(event.phase));
	const forcedLanguage =
		options?.language && options.language !== "auto" ? options.language : undefined;
	return api
		.transcribe({ samples, language: forcedLanguage })
		.then((result) => {
			const words = result.wordSegments ?? [];
			let segments: CaptionSegment[];
			let granularity: CaptionTimestampGranularity;
			if (words.length > 0) {
				segments = words.map((w) => ({
					startSec: w.startSec,
					endSec: w.endSec,
					text: w.word,
				}));
				granularity = "word";
			} else {
				// ponytail: aligner dropped every word (e.g. OOV heavy); fall back to
				// raw phrase spans so the user still gets captions to edit.
				segments = result.segments ?? [];
				granularity = "phrase";
			}
			return { segments, granularity, detectedLanguage: result.detectedLanguage };
		})
		.finally(() => {
			unsubscribe?.();
		});
}
