import { App, DataAdapter, TFile } from "obsidian";
import { applyReferences, findReferences, revertReferences } from "./links";
import type { Reference } from "./links";
import type { LinkIndex } from "./linkindex";
import { OUTPUT_EXTENSION } from "./compress";
import type { OriginalHandling } from "./settings";

/**
 * Thrown when the image could not be replaced. The original is always still
 * there, under its own name, when this is raised — that is what the ordering
 * below buys, and it is the one guarantee this module exists to provide.
 */
export class ReplaceFailure extends Error {
	constructor(readonly originalPath: string, readonly cause: unknown) {
		super(reasonOf(cause));
		this.name = "ReplaceFailure";
	}
}

function reasonOf(cause: unknown): string {
	if (cause instanceof Error) return cause.message;
	return String(cause);
}

/**
 * Paths this plugin is in the middle of writing itself, so their own events do
 * not feed back into anything watching the vault.
 */
export class InternalWrites {
	private readonly paths = new Set<string>();

	claim(path: string): void {
		this.paths.add(path);
	}

	release(path: string): void {
		this.paths.delete(path);
	}

	has(path: string): boolean {
		return this.paths.has(path);
	}
}

/**
 * Replaces an image with its WebP version and moves every link over to it.
 *
 * Three properties, each bought with a real incident:
 *
 * 1. **The image is never re-created.** Plugins such as
 *    obsidian-paste-image-rename rename every *newly created* attachment from
 *    their own `create` handler, asynchronously — so a `createBinary` here,
 *    followed by any same-tick check that the name survived, passes and then
 *    loses the file moments later. `modifyBinary` writes over the image in
 *    place and `renameFile` changes its extension; neither fires `create`, so
 *    there is nothing to react to. **No file is created in the vault at all**:
 *    the copy of the original is written through the adapter into a hidden
 *    folder, which Obsidian does not index and therefore no plugin can see.
 *
 *    That last part was learned twice. A copy sitting in the vault gets renamed
 *    by whatever else is listening, and the rename is not the damage — the
 *    collision is. Named `x.png` it became a second image called after the open
 *    note, and Obsidian rewrote a link in an unrelated note to disambiguate.
 *    Renamed to `x.png.slimmerbak` it stopped colliding with images and started
 *    colliding with *notes* instead, because the name it is given is the open
 *    note's. There is no safe name; the fix is not to be in the namespace.
 *
 * 2. **Renaming goes through `FileManager`,** which is editor-aware. Rewriting
 *    a note on disk while the user has it open lets the editor's buffer flush
 *    over the change; a note ended up holding both the old and the new link
 *    that way. `FileManager.renameFile` handles open editors and ordinary
 *    links; our own index only patches what it cannot see, links inside fenced
 *    code blocks.
 *
 * 3. **Nothing irreversible happens until everything else has been verified,
 *    and a failure rolls back all of it** — notes included. Restoring the image
 *    but leaving notes pointing at a name it no longer has just moves the
 *    breakage somewhere harder to spot.
 */
export async function replaceWithWebp(
	app: App,
	file: TFile,
	bytes: ArrayBuffer,
	mode: OriginalHandling,
	internal: InternalWrites,
	index: LinkIndex
): Promise<void> {
	const originalPath = file.path;
	const targetPath = webpPath(file);

	if (app.vault.getAbstractFileByPath(targetPath)) {
		throw new ReplaceFailure(
			originalPath,
			new Error(`"${targetPath}" already exists, so this one was left alone`)
		);
	}

	// Read before anything changes: this is what makes the rollback exact.
	const originalBytes = await app.vault.readBinary(file);
	const references = findReferences(index, file, OUTPUT_EXTENSION);

	let stash: Stash | null = null;
	if (mode === "trash") {
		stash = await stashOriginal(app, file, originalBytes);
	}

	internal.claim(originalPath);
	internal.claim(targetPath);
	let renamed = false;
	let rewroteNotes = false;
	try {
		await app.vault.modifyBinary(file, bytes);

		await app.fileManager.renameFile(file, targetPath);
		renamed = true;
		await settleAt(app, file, targetPath);

		rewroteNotes = true;
		await applyReferences(app, references, index);
		assertLinksResolve(app, references);
	} catch (error) {
		// Where the image actually is decides what a correct rollback looks
		// like, so that is established before anything else is undone.
		const home = await moveBack(app, file, originalPath, renamed);
		if (home) {
			// Notes first: they are the part that is awkward to undo, and
			// leaving them changed is what strands links.
			if (rewroteNotes) await revertReferences(app, references, index);
			await restore(app, file, originalBytes);
			if (stash) await dropStash(app, stash);
			throw new ReplaceFailure(originalPath, error);
		}

		// It could not be brought back. Writing the old bytes into it now would
		// produce exactly the thing this whole module exists to avoid — a file
		// whose name and contents disagree — and reverting the notes would point
		// them at a name nothing holds. So the forward state is left consistent
		// and the failure says plainly what happened.
		//
		// The copy is trashed, not dropped: the image now holds WebP bytes, so
		// this copy is the only original left and throwing it away would be the
		// one truly unrecoverable thing this module could do.
		if (stash) await trashStash(app, stash);
		throw new ReplaceFailure(
			originalPath,
			new Error(
				`${reasonOf(error)}; it is now at "${describePath(app, file, targetPath)}" ` +
					`and the links point there`
			)
		);
	} finally {
		internal.release(originalPath);
		internal.release(targetPath);
	}

	if (stash) await trashStash(app, stash);
}

/** A copy of an original, parked outside the vault's namespace. */
interface Stash {
	/** Vault-relative path of the copy, inside a hidden folder. */
	path: string;
	/** The per-image folder holding it, removed once the copy is gone. */
	folder: string;
}

/**
 * Hidden folder the originals pass through on their way to the trash.
 *
 * A leading dot keeps it out of Obsidian's file index entirely: no `TFile`, no
 * `create` event, nothing for another plugin to find or rename. Each copy gets
 * its own subfolder so it can keep the original filename unchanged — that name
 * is what the user sees in the trash, and it is how a file gets recognised if
 * it ever has to come back.
 */
const STASH_FOLDER = ".photo-slimmer-originals";

let stashCounter = 0;

async function stashOriginal(app: App, file: TFile, bytes: ArrayBuffer): Promise<Stash> {
	const adapter = app.vault.adapter;
	await makeFolder(adapter, STASH_FOLDER);

	const folder = `${STASH_FOLDER}/${Date.now().toString(36)}-${stashCounter++}`;
	await makeFolder(adapter, folder);
	const path = `${folder}/${file.name}`;
	await adapter.writeBinary(path, bytes);
	return { path, folder };
}

/** Sends the copy to the system trash under the name it always had. */
async function trashStash(app: App, stash: Stash): Promise<void> {
	const adapter = app.vault.adapter;
	try {
		// `trashSystem` reports false rather than throwing when the platform has
		// no system trash; the vault's own .trash is then the honest fallback,
		// because silently deleting an original is not an option.
		if (!(await adapter.trashSystem(stash.path))) {
			await adapter.trashLocal(stash.path);
		}
	} catch (error) {
		console.error(`Photo Slimmer: could not trash the copy of ${stash.path}`, error);
		return; // leave it on disk rather than lose it
	}
	await removeFolder(adapter, stash.folder);
}

/** Throws the copy away: only ever called when the original is back in place. */
async function dropStash(app: App, stash: Stash): Promise<void> {
	const adapter = app.vault.adapter;
	try {
		await adapter.remove(stash.path);
	} catch {
		/* a stray copy is better than masking the real error */
	}
	await removeFolder(adapter, stash.folder);
}

async function makeFolder(adapter: DataAdapter, path: string): Promise<void> {
	if (await adapter.exists(path)) return;
	try {
		await adapter.mkdir(path);
	} catch (error) {
		if (!(await adapter.exists(path))) throw error;
	}
}

async function removeFolder(adapter: DataAdapter, path: string): Promise<void> {
	try {
		await adapter.rmdir(path, true);
	} catch {
		/* an empty folder left behind is harmless */
	}
}

/** Where a compressed image goes: same folder, same name, `.webp`. */
export function webpPath(file: TFile): string {
	return `${folderPrefix(file)}${file.basename}.${OUTPUT_EXTENSION}`;
}

/**
 * Waits until the vault agrees the image is at `targetPath`.
 *
 * `FileManager.renameFile` resolves before `TFile.path` has been updated, so
 * reading that field straight afterwards sees the *old* path. An earlier
 * version asserted on it and mislabelled 113 files: the check "failed", the
 * rollback saw a path that already looked original and did nothing, the old
 * bytes were written back, and the rename then landed — leaving PNG data under
 * a .webp name.
 *
 * The vault's own index is the authority, and it is polled with a deadline
 * rather than assumed. A deadline is not a guess: reaching it means rolling
 * back, which is safe, and passing it is genuine confirmation.
 */
async function settleAt(app: App, file: TFile, targetPath: string): Promise<void> {
	const deadline = Date.now() + 5000;
	for (;;) {
		if (app.vault.getAbstractFileByPath(targetPath) === file) return;
		if (Date.now() >= deadline) {
			throw new Error(`it did not arrive at "${targetPath}" within five seconds`);
		}
		await new Promise((resolve) => window.setTimeout(resolve, 25));
	}
}

/**
 * Puts the image back at its original path, and reports whether it is really
 * there. Deliberately does not read `file.path`, for the reason above.
 */
async function moveBack(
	app: App,
	file: TFile,
	originalPath: string,
	renamed: boolean
): Promise<boolean> {
	if (app.vault.getAbstractFileByPath(originalPath) === file) return true;
	if (!renamed) return false;

	const occupant = app.vault.getAbstractFileByPath(originalPath);
	if (occupant) return false; // something else took the name; do not fight it

	try {
		await app.fileManager.renameFile(file, originalPath);
		await settleAt(app, file, originalPath);
		return true;
	} catch (error) {
		console.error(`Photo Slimmer: could not move ${originalPath} back`, error);
		return false;
	}
}

/** Where the image really is, for a message a human can act on. */
function describePath(app: App, file: TFile, targetPath: string): string {
	return app.vault.getAbstractFileByPath(targetPath) === file ? targetPath : file.path;
}

/** Every link this run rewrote points at a file that exists. */
function assertLinksResolve(app: App, references: Reference[]): void {
	for (const reference of references) {
		const target = linkTarget(reference.replacement);
		if (!target) continue;
		if (!app.metadataCache.getFirstLinkpathDest(target, reference.notePath)) {
			throw new Error(
				`"${reference.notePath}" would be left pointing at "${target}", which does not exist`
			);
		}
	}
}

function linkTarget(link: string): string | null {
	const wiki = link.match(/\[\[([^\]|#\n]+)/);
	if (wiki) return decodeSafely(wiki[1].trim());
	const markdown = link.match(/\]\(([^)\s]+)/);
	if (markdown) return decodeSafely(markdown[1].trim());
	return null;
}

function decodeSafely(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

async function restore(app: App, file: TFile, bytes: ArrayBuffer): Promise<void> {
	try {
		await app.vault.modifyBinary(file, bytes);
	} catch {
		// The backup copy is still on disk, and the caller reports the failure.
	}
}

function folderPrefix(file: TFile): string {
	const folder = file.parent?.path;
	return !folder || folder === "/" ? "" : `${folder}/`;
}
