import { App, TFile } from "obsidian";
import { compressImage, isSourceExtension } from "./compress";
import type { SkipReason } from "./compress";
import type { LinkIndex } from "./linkindex";
import { InternalWrites, ReplaceFailure, replaceWithWebp } from "./replace";
import { isExcluded, parseExcludedFolders } from "./settings";
import type { SlimmerSettings } from "./settings";

export interface Done {
	name: string;
	path: string;
	/** Set when the plain `.webp` name was taken and the image got a numbered one. */
	renamedFrom?: string;
	before: number;
	after: number;
	dimensions: string;
}

/** Why an image was left alone, as a category the report can group by. */
export type LeftKind = SkipReason | "moved" | "failed";

export interface Left {
	name: string;
	path: string;
	size: number;
	mtime: number;
	kind: LeftKind;
	reason: string;
}

/**
 * Verdicts that hold until the file or the settings change, so a later run
 * need not spend its allowance finding them out again. An encoder failure and
 * a file that moved mid-run are not on the list: neither says anything lasting
 * about the image.
 */
export const LASTING_KINDS: ReadonlySet<LeftKind> = new Set<LeftKind>([
	"not-smaller",
	"wrong-format",
	"undecodable",
]);

export interface RunReport {
	done: Done[];
	skipped: Left[];
	failed: Left[];
	/** True when the user stopped it part way. */
	cancelled: boolean;
	elapsedMs: number;
}

/** Plain-language versions of the compressor's own verdicts. */
const SKIP_REASONS: Record<SkipReason, string> = {
	"not-smaller": "the WebP came out no smaller",
	"unsupported-format": "this format is not one the plugin converts",
	"wrong-format": "its name does not match what it really is",
	undecodable: "it could not be decoded, so it was left untouched",
	"encode-failed": "the encoder failed, so it was left untouched",
};

/** Section headings in the report, one per kind, in the order they are shown. */
export const KIND_TITLES: Record<LeftKind, string> = {
	failed: "Could not be replaced",
	"wrong-format": "Not really the format its name says",
	undecodable: "Could not be decoded",
	"encode-failed": "The encoder failed",
	"not-smaller": "Would not get smaller",
	"unsupported-format": "Format not converted",
	moved: "Moved or deleted mid-run",
};

function skipReason(reason: SkipReason, detail: string | undefined): string {
	// The wrong-format detail is the whole message; elsewhere it is a raw
	// error worth keeping, but only after the sentence a person can read.
	if (reason === "wrong-format" && detail) return detail;
	return detail ? `${SKIP_REASONS[reason]} (${detail})` : SKIP_REASONS[reason];
}

/**
 * Everything the run would look at: an image in a convertible format, big
 * enough to be worth it, outside the excluded folders.
 *
 * `.webp` is not a source format, so a file this plugin has already converted
 * is not a candidate a second time. Images an earlier run left alone, and that
 * have not changed since, are held back too — see {@link LeftAloneMemory} for
 * why a capped run would otherwise stall on them.
 */
export function findCandidates(
	app: App,
	settings: SlimmerSettings,
	isRemembered: (file: TFile) => boolean = () => false
): { candidates: TFile[]; remembered: number } {
	const excluded = parseExcludedFolders(settings.excludedFolders);
	const floor = settings.minSizeKb * 1024;
	let remembered = 0;

	const candidates = app.vault
		.getFiles()
		.filter((file) => {
			if (!isSourceExtension(file.extension)) return false;
			if (file.stat.size <= floor || isExcluded(file.path, excluded)) return false;
			if (isRemembered(file)) {
				remembered++;
				return false;
			}
			return true;
		})
		.sort((a, b) => b.stat.size - a.stat.size);

	return { candidates, remembered };
}

/**
 * The slice of the candidate list a single run will actually do.
 *
 * Taken off the front, so a capped run is the biggest images — the ones where
 * the saving is worth the most and where anything gone wrong is most visible.
 * The next run picks up where this one left off: the files it converted are
 * no longer candidates, and the ones it left alone are remembered.
 */
export function limitCandidates(files: TFile[], maxPerRun: number): TFile[] {
	if (!Number.isFinite(maxPerRun) || maxPerRun <= 0) return files;
	return files.slice(0, Math.floor(maxPerRun));
}

export interface RunHooks {
	/** Called before each file, for the progress display. */
	onProgress: (index: number, total: number, file: TFile) => void;
	/** Checked between files so a long run can be stopped. */
	isCancelled: () => boolean;
}

/**
 * Works through the candidates one at a time.
 *
 * Serial on purpose: an 8 MB photo decodes to roughly 48 MB of RGBA, and
 * several at once is enough to have the renderer killed. The yield between
 * files is what keeps the window responsive and the cancel button live.
 */
export async function runCompression(
	app: App,
	files: TFile[],
	settings: SlimmerSettings,
	index: LinkIndex,
	internal: InternalWrites,
	hooks: RunHooks
): Promise<RunReport> {
	const report: RunReport = { done: [], skipped: [], failed: [], cancelled: false, elapsedMs: 0 };
	const started = Date.now();

	for (let i = 0; i < files.length; i++) {
		if (hooks.isCancelled()) {
			report.cancelled = true;
			break;
		}

		const file = files[i];
		hooks.onProgress(i, files.length, file);

		try {
			await one(app, file, settings, index, internal, report);
		} catch (error) {
			report.failed.push({
				name: file.name,
				path: file.path,
				size: file.stat.size,
				mtime: file.stat.mtime,
				kind: "failed",
				reason: error instanceof ReplaceFailure ? error.message : String(error),
			});
		}

		// Hand the main thread back so the progress bar paints and Cancel works.
		await new Promise((resolve) => window.setTimeout(resolve, 0));
	}

	report.elapsedMs = Date.now() - started;
	return report;
}

async function one(
	app: App,
	file: TFile,
	settings: SlimmerSettings,
	index: LinkIndex,
	internal: InternalWrites,
	report: RunReport
): Promise<void> {
	// The vault may have moved on since the candidate list was taken.
	if (app.vault.getAbstractFileByPath(file.path) !== file) {
		report.skipped.push({
			name: file.name,
			path: file.path,
			size: file.stat.size,
			mtime: file.stat.mtime,
			kind: "moved",
			reason: "it was moved or deleted before its turn",
		});
		return;
	}

	const before = file.stat.size;
	const mtime = file.stat.mtime;
	const originalName = file.name;
	const bytes = await app.vault.readBinary(file);
	const outcome = await compressImage(bytes, file.extension, {
		maxEdge: settings.maxEdge,
		quality: settings.quality,
		jpegQuality: settings.jpegQuality,
		minSavingPercent: settings.minSavingPercent,
	});

	if (!outcome.ok) {
		report.skipped.push({
			name: file.name,
			path: file.path,
			size: before,
			mtime,
			kind: outcome.reason,
			reason: skipReason(outcome.reason, outcome.detail),
		});
		return;
	}

	const { result } = outcome;
	const target = await replaceWithWebp(
		app,
		file,
		result.bytes,
		settings.originalHandling,
		internal,
		index
	);

	report.done.push({
		name: target.path.split("/").pop() ?? target.path,
		path: target.path,
		renamedFrom: target.suffix ? originalName : undefined,
		before,
		after: result.bytes.byteLength,
		dimensions:
			result.width === result.sourceWidth
				? `${result.width}×${result.height}`
				: `${result.sourceWidth}×${result.sourceHeight} → ${result.width}×${result.height}`,
	});
}
