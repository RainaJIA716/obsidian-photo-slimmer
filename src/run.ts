import { App, TFile } from "obsidian";
import { compressImage, isSourceExtension } from "./compress";
import type { LinkIndex } from "./linkindex";
import { InternalWrites, ReplaceFailure, replaceWithWebp, webpPath } from "./replace";
import { isExcluded, parseExcludedFolders } from "./settings";
import type { SlimmerSettings } from "./settings";

export interface Done {
	name: string;
	path: string;
	before: number;
	after: number;
	dimensions: string;
}

export interface Left {
	name: string;
	path: string;
	size: number;
	reason: string;
}

export interface RunReport {
	done: Done[];
	skipped: Left[];
	failed: Left[];
	/** True when the user stopped it part way. */
	cancelled: boolean;
	elapsedMs: number;
}

/** Plain-language versions of the compressor's own verdicts. */
const SKIP_REASONS: Record<string, string> = {
	"not-smaller": "the WebP came out no smaller",
	"unsupported-format": "this format is not one the plugin converts",
	undecodable: "it could not be decoded, so it was left untouched",
	"encode-failed": "the encoder failed, so it was left untouched",
};

/**
 * Everything the run would look at: an image in a convertible format, big
 * enough to be worth it, outside the excluded folders.
 *
 * `.webp` is not a source format, so a file this plugin has already converted
 * is not a candidate a second time. That is the whole of the "already done"
 * bookkeeping — no state to keep, nothing to get out of step with the vault.
 */
export function findCandidates(app: App, settings: SlimmerSettings): TFile[] {
	const excluded = parseExcludedFolders(settings.excludedFolders);
	const floor = settings.minSizeKb * 1024;

	return app.vault
		.getFiles()
		.filter(
			(file) =>
				isSourceExtension(file.extension) &&
				file.stat.size > floor &&
				!isExcluded(file.path, excluded)
		)
		.sort((a, b) => b.stat.size - a.stat.size);
}

/**
 * The slice of the candidate list a single run will actually do.
 *
 * Taken off the front, so a capped run is the biggest images — the ones where
 * the saving is worth the most and where anything gone wrong is most visible.
 * The next run picks up where this one left off without any bookkeeping,
 * because the files it converted are no longer candidates.
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
			reason: "it was moved or deleted before its turn",
		});
		return;
	}

	if (app.vault.getAbstractFileByPath(webpPath(file))) {
		report.skipped.push({
			name: file.name,
			path: file.path,
			size: file.stat.size,
			reason: `"${webpPath(file).split("/").pop()}" already exists`,
		});
		return;
	}

	const before = file.stat.size;
	const bytes = await app.vault.readBinary(file);
	const outcome = await compressImage(bytes, file.extension, {
		maxEdge: settings.maxEdge,
		quality: settings.quality,
		minSavingPercent: settings.minSavingPercent,
	});

	if (!outcome.ok) {
		report.skipped.push({
			name: file.name,
			path: file.path,
			size: before,
			reason: outcome.detail ?? SKIP_REASONS[outcome.reason] ?? outcome.reason,
		});
		return;
	}

	const { result } = outcome;
	await replaceWithWebp(app, file, result.bytes, settings.originalHandling, internal, index);

	report.done.push({
		name: file.name,
		path: file.path,
		before,
		after: result.bytes.byteLength,
		dimensions:
			result.width === result.sourceWidth
				? `${result.width}×${result.height}`
				: `${result.sourceWidth}×${result.sourceHeight} → ${result.width}×${result.height}`,
	});
}
