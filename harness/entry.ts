// Browser harness entry: the pure compressor plus the DOM sugar Obsidian
// provides globally, so the real code runs against real images outside the app.
import { canEncodeWebp, compressImage, fit, isSourceExtension } from "../src/compress";

const globals = globalThis as unknown as Record<string, unknown>;
if (typeof globals.createEl !== "function") {
	globals.createEl = (tag: string) => document.createElement(tag);
}

export { canEncodeWebp, compressImage, fit, isSourceExtension };
