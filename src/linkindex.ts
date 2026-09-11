import { App, TFile } from "obsidian";

export interface Occurrence {
	notePath: string;
	/** The link exactly as written, e.g. `![[Attachments/a.png|300]]`. */
	original: string;
	/** The path part, before any `|` alias or `#` subpath, still percent-encoded. */
	target: string;
}

/**
 * Every image link in the vault, found by reading the markdown rather than by
 * asking the metadata cache.
 *
 * The cache is the obvious source and it has a hole this plugin cannot live
 * with: Obsidian does not parse links inside fenced code blocks, so they are
 * absent from `resolvedLinks` and from `getFileCache().embeds`. A note that
 * embeds an image only from inside a ```gallery block therefore looks like it
 * references nothing — and renaming that image would leave the block pointing
 * at a file that no longer exists.
 *
 * Reading the text directly costs one pass over the markdown in the vault,
 * which is small next to the images: a 7,700-image vault here holds 3,700 notes
 * totalling 21 MB. The index is then kept current per note as notes change.
 */
export class LinkIndex {
	private readonly byNote = new Map<string, Occurrence[]>();
	private built = false;

	constructor(private readonly app: App) {}

	async ensure(): Promise<void> {
		if (this.built) return;
		for (const note of this.app.vault.getMarkdownFiles()) {
			await this.reindex(note);
		}
		this.built = true;
	}

	/** Re-reads one note. Cheap enough to call on every edit. */
	async reindex(note: TFile): Promise<void> {
		const text = await this.app.vault.cachedRead(note);
		const found = parseLinks(text, note.path);
		if (found.length === 0) this.byNote.delete(note.path);
		else this.byNote.set(note.path, found);
	}

	forget(path: string): void {
		this.byNote.delete(path);
	}

	rename(oldPath: string, note: TFile): void {
		const found = this.byNote.get(oldPath);
		this.byNote.delete(oldPath);
		if (!found) return;
		this.byNote.set(
			note.path,
			found.map((o) => ({ ...o, notePath: note.path }))
		);
	}

	/**
	 * Occurrences that actually resolve to `file`.
	 *
	 * The filename match only narrows the search; `getFirstLinkpathDest` decides,
	 * because two folders can hold images with the same name and a bare
	 * `![[photo.png]]` has to land on the right one.
	 */
	referencesTo(file: TFile): Occurrence[] {
		const wanted = file.name.toLowerCase();
		const hits: Occurrence[] = [];

		for (const occurrences of this.byNote.values()) {
			for (const occurrence of occurrences) {
				if (lastSegment(occurrence.target).toLowerCase() !== wanted) continue;
				const dest = this.app.metadataCache.getFirstLinkpathDest(
					decodeTarget(occurrence.target),
					occurrence.notePath
				);
				if (dest === file) hits.push(occurrence);
			}
		}

		return hits;
	}
}

function lastSegment(target: string): string {
	const decoded = decodeTarget(target);
	const slash = decoded.lastIndexOf("/");
	return slash === -1 ? decoded : decoded.slice(slash + 1);
}

function decodeTarget(target: string): string {
	try {
		return decodeURIComponent(target);
	} catch {
		// A stray % that is not an escape sequence; the raw text is the best guess.
		return target;
	}
}

const WIKI = /!?\[\[([^\]\n]+)\]\]/g;
const MARKDOWN = /!?\[[^\]\n]*\]\(([^)\n]+)\)/g;

export function parseLinks(text: string, notePath: string): Occurrence[] {
	const found: Occurrence[] = [];

	for (const match of text.matchAll(WIKI)) {
		const inner = match[1];
		// `|` starts the alias and `#` a subpath; neither belongs to the path.
		const cut = Math.min(
			...[inner.indexOf("|"), inner.indexOf("#")].map((i) => (i === -1 ? inner.length : i))
		);
		found.push({ notePath, original: match[0], target: inner.slice(0, cut).trim() });
	}

	for (const match of text.matchAll(MARKDOWN)) {
		let target = match[1].trim();
		// A markdown link may carry a quoted title after the path.
		const space = target.indexOf(" ");
		if (space !== -1) target = target.slice(0, space);
		if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
		const hash = target.indexOf("#");
		if (hash !== -1) target = target.slice(0, hash);
		if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // skip URLs
		found.push({ notePath, original: match[0], target });
	}

	return found;
}
