import { App, TFile } from "obsidian";
import { parseLinks } from "./linkindex";
import type { LinkIndex } from "./linkindex";

export interface Reference {
	notePath: string;
	/** The link exactly as it appears in the note, e.g. `![[Attachments/a.png|300]]`. */
	original: string;
	/** What it should become once the file has its new name. */
	replacement: string;
}

/**
 * Rewrites only the end of the filename inside a link — the extension, plus a
 * suffix when the image needs a new name — leaving the rest of the text byte for
 * byte as the author wrote it.
 *
 * This is deliberately not `generateMarkdownLink`. Regenerating a link would
 * normalise it — a shortest-form wikilink could come back as a full path, a
 * markdown link as a wikilink, and any `|300` size hint or alt text would have
 * to be reconstructed. Editing the extension in place preserves all of that,
 * including percent-encoding, because it is the only thing that actually
 * changed.
 *
 * The suffix is appended to the stem as written, not to a decoded copy of it,
 * so a percent-encoded link stays percent-encoded. That is safe only because
 * the suffix is plain ASCII with nothing to escape; {@link webpTarget} in
 * replace.ts only ever produces `-<digits>`.
 *
 * Returns null when nothing needs to change, which includes the extensionless
 * `![[photo]]` form: that resolves by basename and keeps working after the
 * rename on its own.
 */
export function retargetLink(
	original: string,
	oldExtension: string,
	newExtension: string,
	suffix = ""
): string | null {
	const bounds = targetBounds(original);
	if (!bounds) return null;

	const target = original.slice(bounds.start, bounds.end);
	const ending = `.${oldExtension.toLowerCase()}`;
	if (!target.toLowerCase().endsWith(ending)) return null;

	const stem = target.slice(0, target.length - ending.length);
	const retargeted = `${stem}${suffix}.${newExtension}`;
	return original.slice(0, bounds.start) + retargeted + original.slice(bounds.end);
}

/** Locates the path portion of a wikilink or a markdown link. */
function targetBounds(original: string): { start: number; end: number } | null {
	const wiki = original.indexOf("[[");
	if (wiki !== -1) {
		const start = wiki + 2;
		const close = original.indexOf("]]", start);
		if (close === -1) return null;
		// A `|` starts the alias and a `#` starts a subpath; neither is the path.
		const alias = original.indexOf("|", start);
		const subpath = original.indexOf("#", start);
		let end = close;
		for (const marker of [alias, subpath]) {
			if (marker !== -1 && marker < end) end = marker;
		}
		return { start, end };
	}

	const open = original.indexOf("](");
	if (open === -1) return null;
	const start = open + 2;
	const close = original.lastIndexOf(")");
	if (close <= start) return null;
	// A markdown link may carry a quoted title after the path.
	const space = original.indexOf(" ", start);
	const end = space !== -1 && space < close ? space : close;
	return { start, end };
}

/**
 * Every link in the vault that points at `file` and would break if its
 * extension changed.
 *
 * Backed by {@link LinkIndex}, which reads the markdown itself. Using the
 * metadata cache here would silently miss links inside fenced code blocks —
 * a real shape in this vault, where 22 images over the size threshold are
 * embedded only from ```gallery blocks.
 */
export function findReferences(
	index: LinkIndex,
	file: TFile,
	newExtension: string,
	suffix = ""
): Reference[] {
	const references: Reference[] = [];
	const seen = new Set<string>();

	for (const occurrence of index.referencesTo(file)) {
		const key = `${occurrence.notePath}\u0000${occurrence.original}`;
		if (seen.has(key)) continue;

		const replacement = retargetLink(
			occurrence.original,
			file.extension,
			newExtension,
			suffix
		);
		if (!replacement) continue;

		seen.add(key);
		references.push({ notePath: occurrence.notePath, original: occurrence.original, replacement });
	}

	return references;
}

/**
 * Applies the rewrites in two phases: every note is read and its new text
 * computed first, and only once all of them are known to be applicable is
 * anything written.
 *
 * One phase is not enough. Writing note by note and throwing partway leaves the
 * earlier notes rewritten and the later ones not — and if the caller then rolls
 * the image back, those notes are left pointing at a file that no longer has
 * that name. That is not hypothetical: it stranded 10 links in a real vault.
 */
export async function applyReferences(
	app: App,
	references: Reference[],
	index?: LinkIndex
): Promise<number> {
	const byNote = new Map<string, Reference[]>();
	for (const reference of references) {
		const list = byNote.get(reference.notePath) ?? [];
		list.push(reference);
		byNote.set(reference.notePath, list);
	}

	// Phase one: work out every edit, and fail here if any of them cannot be made.
	const planned: { note: TFile; before: string; after: string; count: number }[] = [];
	for (const [notePath, list] of byNote) {
		const note = app.vault.getAbstractFileByPath(notePath);
		if (!(note instanceof TFile)) continue;

		const before = await app.vault.cachedRead(note);
		let after = before;
		let count = 0;
		for (const reference of list) {
			if (!after.includes(reference.original)) {
				// Obsidian rewrites links itself when a file is renamed through
				// FileManager, so by the time this runs the link may already be
				// correct — and not necessarily in the form we would have
				// written. It normalises the path as well as the extension:
				// `](Attachments/a%20b.png)` came back as `](a%20b.webp)`, which
				// matches neither our original nor our replacement.
				//
				// So the question is not "is the text what we expected" but "is
				// this link still pointing at the old file". If nothing in the
				// note names the old file any more, someone else already moved
				// it and there is nothing left to do.
				if (after.includes(reference.replacement)) continue;
				if (!stranded(app, after, reference)) continue;
				throw new Error(
					`"${notePath}" still points at ${targetName(reference.original)} ` +
						`in a form this plugin did not write; it was left alone`
				);
			}
			// Split/join rather than replace: every occurrence points at the same
			// file, including any inside code blocks that the metadata cache did
			// not report.
			after = after.split(reference.original).join(reference.replacement);
			count++;
		}
		if (count > 0) planned.push({ note, before, after, count });
	}

	// Phase two: write. `process` re-reads under the vault's own lock, so a note
	// edited between the phases is caught here rather than silently clobbered.
	let rewritten = 0;
	const written: { note: TFile; before: string }[] = [];
	try {
		for (const edit of planned) {
			await app.vault.process(edit.note, (current) => {
				if (current !== edit.before) {
					throw new Error(
						`"${edit.note.path}" changed while the image was being converted`
					);
				}
				return edit.after;
			});
			written.push({ note: edit.note, before: edit.before });
			rewritten += edit.count;
			if (index) await index.reindex(edit.note);
		}
	} catch (error) {
		await undoWrites(app, written, index);
		throw error;
	}

	return rewritten;
}

/** The filename a link points at, e.g. `a%20b.png` from `![](x/a%20b.png)`. */
function targetName(original: string): string {
	const bounds = targetBounds(original);
	const target = bounds ? original.slice(bounds.start, bounds.end) : original;
	const slash = target.lastIndexOf("/");
	return slash === -1 ? target : target.slice(slash + 1);
}

/**
 * Whether the note is left holding a link that no longer resolves.
 *
 * Matching on the filename alone is not enough. A vault can hold two different
 * images with the same name in different folders, and one note can embed both:
 *
 *     ![](.../附件/图片/idea-2.png)   <- the one being converted
 *     ![](.../附件/idea-2.png)        <- a different file, below the threshold
 *
 * Rewriting the first leaves the second untouched and still naming `idea-2.png`,
 * which an earlier version of this check read as "we failed to move a link" and
 * refused. It cost 17 conversions in a real vault — no damage, because the
 * refusal rolls everything back, but no conversion either.
 *
 * The precise question is not "is that name still here" but "is anything now
 * broken". Obsidian's own resolver answers it: by this point the image has been
 * renamed and the vault index has confirmed it, so a link of that name which
 * still resolves is pointing at some other file that exists, and is none of our
 * business. One that resolves to nothing is a link we stranded.
 */
function stranded(app: App, text: string, reference: Reference): boolean {
	const name = targetName(reference.original);
	for (const occurrence of parseLinks(text, reference.notePath)) {
		if (lastSegment(occurrence.target) !== name) continue;
		const target = decodeSafely(occurrence.target);
		if (!app.metadataCache.getFirstLinkpathDest(target, reference.notePath)) return true;
	}
	return false;
}

function lastSegment(target: string): string {
	const slash = target.lastIndexOf("/");
	return slash === -1 ? target : target.slice(slash + 1);
}

function decodeSafely(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

/** Puts back the notes already written when a later one could not be. */
async function undoWrites(
	app: App,
	written: { note: TFile; before: string }[],
	index?: LinkIndex
): Promise<void> {
	for (const entry of written) {
		try {
			await app.vault.process(entry.note, () => entry.before);
			if (index) await index.reindex(entry.note);
		} catch {
			// Reported by the original error; a failure here must not mask it.
		}
	}
}

/** Reverts note rewrites after the image itself has been put back. */
export async function revertReferences(
	app: App,
	references: Reference[],
	index?: LinkIndex
): Promise<void> {
	const flipped = references.map((r) => ({
		notePath: r.notePath,
		original: r.replacement,
		replacement: r.original,
	}));
	try {
		await applyReferences(app, flipped, index);
	} catch {
		// Best effort: the caller is already reporting a failure.
	}
}
