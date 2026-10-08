import type { DataAdapter, TFile } from "obsidian";
import type { SlimmerSettings } from "./settings";

/** One image a run left alone, and the state it and the settings were in. */
interface Entry {
	size: number;
	mtime: number;
	/** The settings that produced the verdict; see {@link verdictKey}. */
	settings: string;
	reason: string;
}

/**
 * Images that were left alone for a reason that will not change by itself.
 *
 * Without this, a capped run can stall for good. Candidates are taken biggest
 * first, and an image that came out no smaller is still a candidate next time,
 * still near the top — so once the biggest N images are all ones that cannot be
 * converted, every run spends its whole allowance re-trying them and converts
 * nothing. A real vault had over 200 such images, against a default cap of 50.
 *
 * The verdict is tied to the file *and* the settings that produced it. Edit the
 * image, or lower the quality, and it is a candidate again. The "already done"
 * bookkeeping for converted images still needs no state: a `.webp` is simply
 * not a source format.
 *
 * Kept in its own file beside the plugin rather than in `data.json`. The
 * settings tab persists the settings object as the whole of `data.json`, and
 * anything else stored there would be wiped the first time a slider moved.
 */
export class LeftAloneMemory {
	private entries: Record<string, Entry> = {};

	constructor(
		private readonly adapter: DataAdapter,
		private readonly path: string
	) {}

	async load(): Promise<void> {
		try {
			if (!(await this.adapter.exists(this.path))) return;
			const parsed: unknown = JSON.parse(await this.adapter.read(this.path));
			if (parsed && typeof parsed === "object") this.entries = parsed as Record<string, Entry>;
		} catch (error) {
			// Losing this costs one run of re-trying; refusing to start costs more.
			console.warn("Photo Slimmer: could not read the list of images left alone", error);
			this.entries = {};
		}
	}

	async save(): Promise<void> {
		await this.adapter.write(this.path, JSON.stringify(this.entries));
	}

	/** Whether this file, as it is now, already got a verdict under these settings. */
	remembers(file: TFile, settings: SlimmerSettings): boolean {
		const entry = this.entries[file.path];
		return (
			entry !== undefined &&
			entry.size === file.stat.size &&
			entry.mtime === file.stat.mtime &&
			entry.settings === verdictKey(settings)
		);
	}

	remember(
		item: { path: string; size: number; mtime: number; reason: string },
		settings: SlimmerSettings
	): void {
		this.entries[item.path] = {
			size: item.size,
			mtime: item.mtime,
			settings: verdictKey(settings),
			reason: item.reason,
		};
	}

	/** Drops entries for paths the vault no longer holds. */
	prune(exists: (path: string) => boolean): void {
		for (const path of Object.keys(this.entries)) {
			if (!exists(path)) delete this.entries[path];
		}
	}

	clear(): void {
		this.entries = {};
	}

	get count(): number {
		return Object.keys(this.entries).length;
	}
}

/**
 * The settings a verdict depends on. The size threshold, the cap and the
 * excluded folders decide whether an image is looked at, not what happens to
 * it, so changing them does not bring anything back.
 */
function verdictKey(settings: SlimmerSettings): string {
	return [
		settings.maxEdge,
		settings.quality,
		settings.jpegQuality,
		settings.minSavingPercent,
	].join("/");
}
