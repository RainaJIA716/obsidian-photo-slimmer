// Pure image compression: decode, scale down if oversized, encode as WebP.
//
// Deliberately free of any Obsidian import so the whole thing can be bundled
// and exercised in a browser harness against real photos before it ever goes
// near a vault. The only ambient dependency is `createEl`, which Obsidian
// defines globally and the harness polyfills.
//
// WebP is the only output. Measured across 60 randomly sampled oversized PNGs
// from a real vault, WebP at quality 90 came out 85% smaller on average and 54%
// smaller in the worst case, against 76% for JPEG — and unlike JPEG it keeps an
// alpha channel, so there is no transparency test to get wrong and no per-image
// format decision to branch on.

export interface CompressOptions {
	/** Longest edge of the output, in pixels. 0 means never scale down. */
	maxEdge: number;
	/** WebP encoder quality, 1-100. */
	quality: number;
	/** Give up unless the output is at least this much smaller, in percent. */
	minSavingPercent: number;
}

export interface CompressResult {
	bytes: ArrayBuffer;
	width: number;
	height: number;
	sourceWidth: number;
	sourceHeight: number;
}

/**
 * Why a file was left alone. Every one of these is a normal outcome, not a
 * failure: the contract is that an image is either made meaningfully smaller or
 * not touched at all.
 */
export type SkipReason = "unsupported-format" | "undecodable" | "encode-failed" | "not-smaller";

export type CompressOutcome =
	| { ok: true; result: CompressResult }
	| { ok: false; reason: SkipReason; detail?: string };

export const OUTPUT_EXTENSION = "webp";
const OUTPUT_MIME = "image/webp";

/** Formats worth converting. `webp` is absent on purpose: it is the output. */
const SOURCE_MIME: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
};

export function mimeForExtension(extension: string): string | null {
	return SOURCE_MIME[extension.toLowerCase()] ?? null;
}

export function isSourceExtension(extension: string): boolean {
	return extension.toLowerCase() in SOURCE_MIME;
}

/**
 * Whether this engine can encode WebP at all.
 *
 * Desktop Obsidian always can. The check exists so a build running somewhere
 * older fails loudly at the start of a run rather than silently writing PNG
 * bytes under a `.webp` name.
 */
export async function canEncodeWebp(): Promise<boolean> {
	try {
		const canvas = createEl("canvas");
		canvas.width = 4;
		canvas.height = 4;
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, OUTPUT_MIME, 0.9)
		);
		release(canvas);
		return blob?.type === OUTPUT_MIME;
	} catch {
		return false;
	}
}

export async function compressImage(
	bytes: ArrayBuffer,
	extension: string,
	options: CompressOptions
): Promise<CompressOutcome> {
	const mime = mimeForExtension(extension);
	if (!mime) return { ok: false, reason: "unsupported-format", detail: extension };

	let bitmap: ImageBitmap;
	try {
		bitmap = await decode(bytes, mime);
	} catch (error) {
		return { ok: false, reason: "undecodable", detail: String(error) };
	}

	try {
		const sourceWidth = bitmap.width;
		const sourceHeight = bitmap.height;
		const [width, height] = fit(sourceWidth, sourceHeight, options.maxEdge);

		let blob: Blob | null;
		try {
			blob = await render(bitmap, width, height, options.quality);
		} catch (error) {
			return { ok: false, reason: "encode-failed", detail: String(error) };
		}
		if (!blob || blob.size === 0) {
			return { ok: false, reason: "encode-failed", detail: "the encoder returned nothing" };
		}
		if (blob.type !== OUTPUT_MIME) {
			// Chromium quietly hands back a PNG when it cannot encode the type
			// asked for, which would put PNG bytes under a .webp name.
			return { ok: false, reason: "encode-failed", detail: "this build cannot encode WebP" };
		}

		if (blob.size > bytes.byteLength * (1 - options.minSavingPercent / 100)) {
			return { ok: false, reason: "not-smaller" };
		}

		const out = await exactBytes(blob);

		// Never hand back something that cannot be read again. This is the last
		// line of defence before the original is disposed of.
		try {
			const check = await decode(out, OUTPUT_MIME);
			check.close();
		} catch (error) {
			return {
				ok: false,
				reason: "encode-failed",
				detail: `the output did not decode: ${String(error)}`,
			};
		}

		return { ok: true, result: { bytes: out, width, height, sourceWidth, sourceHeight } };
	} finally {
		bitmap.close();
	}
}

/**
 * `imageOrientation: "from-image"` is passed explicitly and a decoder that
 * rejects it is treated as a decode failure rather than falling back.
 *
 * The fallback is the tempting move and it is wrong: canvas output carries no
 * EXIF, so a decode that ignored the orientation tag would be written back
 * permanently sideways. There is no reliable way to tell afterwards whether a
 * given engine applied the tag, so a photo we cannot orient confidently is a
 * photo we leave alone.
 */
async function decode(bytes: ArrayBuffer, mime: string): Promise<ImageBitmap> {
	return createImageBitmap(new Blob([bytes], { type: mime }), {
		imageOrientation: "from-image",
	});
}

/**
 * Floor for the short edge, in pixels.
 *
 * Capping the long edge alone ruins long screenshots: a 2654x17474 capture
 * scaled until its 17474px side fits in 2560 comes out 388px wide, far too
 * narrow to read. So the short edge is allowed to hold the scale back, and a
 * tall image simply stays taller than maxEdge.
 */
const MIN_SHORT_EDGE = 1080;

export function fit(
	width: number,
	height: number,
	maxEdge: number,
	minShortEdge = MIN_SHORT_EDGE
): [number, number] {
	if (maxEdge <= 0) return [width, height];
	const longest = Math.max(width, height);
	const shortest = Math.min(width, height);
	if (longest <= maxEdge) return [width, height];

	let scale = maxEdge / longest;
	// Only defend a short edge the image actually has; a genuinely small image
	// is never scaled up to reach the floor.
	const floor = Math.min(shortest, minShortEdge);
	if (shortest * scale < floor) scale = floor / shortest;
	if (scale >= 1) return [width, height];

	// At least 1px in each direction, and never round up into an upscale.
	return [Math.max(1, Math.floor(width * scale)), Math.max(1, Math.floor(height * scale))];
}

async function render(
	bitmap: ImageBitmap,
	width: number,
	height: number,
	quality: number
): Promise<Blob | null> {
	// A single drawImage that shrinks by more than 2x samples too sparsely and
	// leaves visible aliasing, so step down by halves first and let the last hop
	// cover the remainder.
	let source: ImageBitmap | HTMLCanvasElement = bitmap;
	let sourceWidth = bitmap.width;
	let sourceHeight = bitmap.height;
	const scratch: HTMLCanvasElement[] = [];

	try {
		while (
			sourceWidth >= width * 2 &&
			sourceHeight >= height * 2 &&
			sourceWidth > 1 &&
			sourceHeight > 1
		) {
			const halfWidth = Math.max(width, Math.floor(sourceWidth / 2));
			const halfHeight = Math.max(height, Math.floor(sourceHeight / 2));
			if (halfWidth === sourceWidth && halfHeight === sourceHeight) break;
			const step = paint(source, halfWidth, halfHeight);
			scratch.push(step);
			source = step;
			sourceWidth = halfWidth;
			sourceHeight = halfHeight;
		}

		const canvas = paint(source, width, height);
		try {
			return await new Promise<Blob | null>((resolve) =>
				canvas.toBlob(resolve, OUTPUT_MIME, Math.min(100, Math.max(1, quality)) / 100)
			);
		} finally {
			release(canvas);
		}
	} finally {
		for (const canvas of scratch) release(canvas);
	}
}

/**
 * No background is painted in. WebP stores an alpha channel, so transparency
 * survives the round trip and there is nothing to flatten it onto.
 */
function paint(
	source: ImageBitmap | HTMLCanvasElement,
	width: number,
	height: number
): HTMLCanvasElement {
	const canvas = createEl("canvas");
	canvas.width = width;
	canvas.height = height;
	const context = canvas.getContext("2d");
	if (!context) {
		release(canvas);
		throw new Error("could not get a 2d context");
	}
	context.imageSmoothingEnabled = true;
	context.imageSmoothingQuality = "high";
	context.drawImage(source, 0, 0, width, height);
	return canvas;
}

/** Drops the backing store instead of waiting for the canvas to be collected. */
function release(canvas: HTMLCanvasElement): void {
	canvas.width = 0;
	canvas.height = 0;
}

/**
 * Copies into an ArrayBuffer sized exactly to the data. Vault writes must never
 * be handed a view onto a larger pool, or the extra bytes land in the file.
 */
async function exactBytes(blob: Blob): Promise<ArrayBuffer> {
	const source = new Uint8Array(await blob.arrayBuffer());
	const copy = new Uint8Array(source.byteLength);
	copy.set(source);
	return copy.buffer;
}
