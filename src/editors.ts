import { App, MarkdownView, TFile } from "obsidian";

/**
 * Writes every open note's editor buffer to disk before the run touches
 * anything.
 *
 * Obsidian keeps an unsaved editor buffer in memory and flushes it on its own
 * schedule. A note edited but not yet flushed will overwrite whatever this
 * plugin wrote to that file in the meantime — a note ended up holding both the
 * old and the new link that way, because the buffer landed on top of our
 * rewrite seconds later.
 *
 * Flushing first removes the conflict rather than racing it: with no unsaved
 * changes left, Obsidian reloads each view from disk when the file changes
 * underneath it instead of clobbering it.
 *
 * This matters far more than it might seem. There is always a note open, and
 * the note someone has open when they start a compression run is very often one
 * that shows the images being compressed.
 */
export async function flushOpenNotes(app: App): Promise<number> {
	let flushed = 0;
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const view = leaf.view;
		if (!(view instanceof MarkdownView)) continue;
		try {
			await view.save();
			flushed++;
		} catch (error) {
			console.error("Photo Slimmer: could not save an open note", error);
		}
	}
	return flushed;
}

/** The notes currently open, so a report can say which ones were in the way. */
export function openNotePaths(app: App): Set<string> {
	const paths = new Set<string>();
	for (const leaf of app.workspace.getLeavesOfType("markdown")) {
		const file = (leaf.view as { file?: TFile | null }).file;
		if (file) paths.add(file.path);
	}
	return paths;
}
