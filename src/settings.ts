/** What to do with the image the WebP replaced. */
export type OriginalHandling = "trash" | "overwrite";

export interface SlimmerSettings {
	/**
	 * Ignore anything at or below this size, in KB.
	 *
	 * This is a spending limit on CPU and churn, not a safety check — the
	 * minimum-saving rule below is what stops an image being rewritten for no
	 * gain. Its job is to skip files where the *absolute* win is too small to be
	 * worth a rename and a pass over the notes: 85% of a 300 KB screenshot is a
	 * quarter of a megabyte, while 85% of a 20 KB icon is 17 KB.
	 */
	minSizeKb: number;
	/**
	 * Stop after this many images in one run. 0 means no limit.
	 *
	 * A whole-vault pass over thousands of files is an all-or-nothing bet on a
	 * build you have not watched run yet. A cap turns it into a batch you can
	 * inspect before deciding to do the rest — and because candidates are taken
	 * biggest-first and a converted file is never a candidate again, repeated
	 * runs simply work down the list.
	 */
	maxPerRun: number;
	/** Longest edge of the output, in pixels. 0 keeps the original size. */
	maxEdge: number;
	/** WebP encoder quality, 1-100. */
	quality: number;
	/** Leave the file alone unless it shrinks by at least this much, in percent. */
	minSavingPercent: number;
	originalHandling: OriginalHandling;
	/** One folder path per line. Matches the folder and everything under it. */
	excludedFolders: string;
}

export const DEFAULT_SETTINGS: SlimmerSettings = {
	minSizeKb: 200,
	maxPerRun: 50,
	maxEdge: 2560,
	quality: 90,
	minSavingPercent: 10,
	originalHandling: "trash",
	excludedFolders: "",
};

export const ICON = "image-minus";

export function parseExcludedFolders(raw: string): string[] {
	return raw
		.split("\n")
		.map((line) => line.trim().replace(/^\/+|\/+$/g, ""))
		.filter((line) => line.length > 0);
}

export function isExcluded(path: string, excluded: string[]): boolean {
	return excluded.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

export function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
