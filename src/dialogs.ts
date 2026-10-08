import { App, Modal, Notice, Setting, TFile } from "obsidian";
import { KIND_TITLES } from "./run";
import type { Left, LeftKind, RunReport } from "./run";
import { formatBytes } from "./settings";
import type { SlimmerSettings } from "./settings";

/**
 * What the run is about to do, before it does any of it.
 *
 * A button press is not informed consent when the button is about to rewrite a
 * thousand files, so the count, the total size and the fate of the originals
 * are all stated before anything happens.
 */
export class PreviewModal extends Modal {
	constructor(
		app: App,
		/** The images this run will do. */
		private readonly files: TFile[],
		/** How many candidates there are in all, which may be more. */
		private readonly total: number,
		/** Images held back because an earlier run already left them alone. */
		private readonly remembered: number,
		private readonly settings: SlimmerSettings,
		private readonly onConfirm: () => void
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("photo-slimmer-modal");
		contentEl.createEl("h2", { text: "Compress images to WebP" });

		const bytes = this.files.reduce((sum, file) => sum + file.stat.size, 0);
		const held = this.total - this.files.length;
		const stats = contentEl.createDiv({ cls: "photo-slimmer-stats" });
		stat(stats, "Images", held > 0 ? `${this.files.length} of ${this.total}` : String(this.files.length));
		stat(stats, "Total size", formatBytes(bytes));
		stat(stats, "Largest", formatBytes(this.files[0]?.stat.size ?? 0));

		if (held > 0) {
			contentEl.createEl("p", {
				cls: "photo-slimmer-note",
				text: `This run stops after ${this.files.length} images, the biggest ones first, because of the "Images per run" setting. The other ${held} are left for the next run — run it again to carry on, or raise the limit in settings to do the lot at once.`,
			});
		}

		if (this.remembered > 0) {
			contentEl.createEl("p", {
				cls: "photo-slimmer-note",
				text: `${this.remembered} more ${this.remembered === 1 ? "image was" : "images were"} left alone by an earlier run and ${this.remembered === 1 ? "has" : "have"} not changed since, so ${this.remembered === 1 ? "it is" : "they are"} not tried again. Editing an image or changing the quality settings brings it back; the command "Retry images left alone earlier" brings back all of them.`,
			});
		}

		const naming =
			"Each image is replaced by a WebP of the same name — or, if that name is already taken by a different image, the same name with -1 added.";
		contentEl.createEl("p", {
			cls: "photo-slimmer-note",
			text:
				this.settings.originalHandling === "trash"
					? `${naming} The original goes to the system trash. On an iCloud vault the trash still counts against your storage for 30 days, so the space is not actually freed until then.`
					: `${naming} No copy of the original is kept.`,
		});
		contentEl.createEl("p", {
			cls: "photo-slimmer-note",
			text: "Links are updated for you, including links written inside code blocks. Anything that cannot be replaced safely is left exactly as it is and listed at the end.",
		});

		const list = contentEl.createDiv({ cls: "photo-slimmer-list" });
		for (const file of this.files.slice(0, 8)) {
			const row = list.createDiv({ cls: "photo-slimmer-row" });
			row.createSpan({ cls: "photo-slimmer-name", text: file.name });
			row.createSpan({ cls: "photo-slimmer-size", text: formatBytes(file.stat.size) });
		}
		if (this.files.length > 8) {
			list.createDiv({
				cls: "photo-slimmer-more",
				text: `and ${this.files.length - 8} more`,
			});
		}

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) =>
				button
					.setButtonText(`Compress ${this.files.length}`)
					.setCta()
					.onClick(() => {
						this.close();
						this.onConfirm();
					})
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Live progress, and the only way to stop a long run part way. */
export class ProgressModal extends Modal {
	private cancelled = false;
	private bar!: HTMLElement;
	private label!: HTMLElement;
	private counter!: HTMLElement;

	constructor(app: App, private readonly total: number) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass("photo-slimmer-modal");
		contentEl.createEl("h2", { text: "Compressing" });

		this.counter = contentEl.createDiv({ cls: "photo-slimmer-counter", text: `0 / ${this.total}` });
		const track = contentEl.createDiv({ cls: "photo-slimmer-track" });
		this.bar = track.createDiv({ cls: "photo-slimmer-bar" });
		this.label = contentEl.createDiv({ cls: "photo-slimmer-current", text: "starting…" });

		new Setting(contentEl).addButton((button) =>
			button.setButtonText("Stop").onClick(() => {
				this.cancelled = true;
				this.label.setText("stopping after this image…");
			})
		);
	}

	update(index: number, name: string): void {
		this.counter.setText(`${index} / ${this.total}`);
		// A CSS variable rather than a style assignment: static styling belongs
		// in the stylesheet, and only the value itself is dynamic.
		this.bar.setCssProps({ "--photo-slimmer-progress": `${(index / this.total) * 100}%` });
		this.label.setText(name);
	}

	isCancelled(): boolean {
		return this.cancelled;
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * What actually happened: how many, how much smaller, and — named, with the
 * reason — every image that was left alone or could not be replaced.
 *
 * A bare count is useless. "3 failed" tells the reader something went wrong and
 * gives them no way to find out what.
 */
export class ReportModal extends Modal {
	constructor(app: App, private readonly report: RunReport) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		const { done, skipped, failed, cancelled, elapsedMs } = this.report;
		contentEl.addClass("photo-slimmer-modal");
		contentEl.addClass("photo-slimmer-report");

		const before = done.reduce((sum, d) => sum + d.before, 0);
		const after = done.reduce((sum, d) => sum + d.after, 0);
		const saved = before - after;
		const percent = before > 0 ? Math.round((100 * saved) / before) : 0;

		contentEl.createEl("h2", { text: cancelled ? "Stopped" : "Done" });

		const stats = contentEl.createDiv({ cls: "photo-slimmer-stats" });
		stat(stats, "Compressed", String(done.length));
		stat(stats, "Saved", formatBytes(saved));
		stat(stats, "Smaller by", `${percent}%`);
		stat(stats, "Took", `${Math.round(elapsedMs / 1000)}s`);

		if (done.length > 0) {
			contentEl.createEl("p", {
				cls: "photo-slimmer-note",
				text: `${formatBytes(before)} became ${formatBytes(after)}.`,
			});
		}

		// Failures first: they are the part that may need something done.
		this.section("Could not be replaced", failed, "photo-slimmer-failed", true);

		// A flat list of two hundred lines with the reasons interleaved hides
		// the one line that matters. Grouped, it reads as "95 would not get
		// smaller, 2 are not really PNGs" — and the rare kinds are visible.
		for (const [kind, items] of groupByKind(skipped)) {
			this.section(KIND_TITLES[kind], items, "photo-slimmer-skipped", false);
		}
		if (skipped.some((item) => item.kind === "not-smaller" || item.kind === "wrong-format")) {
			contentEl.createEl("p", {
				cls: "photo-slimmer-note",
				text: 'Images left alone are not tried again until they change or the quality settings do. The command "Retry images left alone earlier" brings them all back.',
			});
		}

		if (done.length > 0) {
			const details = contentEl.createEl("details", { cls: "photo-slimmer-details" });
			details.createEl("summary", { text: `Compressed (${done.length})` });
			const list = details.createDiv({ cls: "photo-slimmer-list" });
			for (const item of done) {
				const row = list.createDiv({ cls: "photo-slimmer-row" });
				row.createSpan({
					cls: "photo-slimmer-name",
					text: item.renamedFrom ? `${item.name} (was ${item.renamedFrom})` : item.name,
				});
				row.createSpan({
					cls: "photo-slimmer-size",
					text: `${formatBytes(item.before)} → ${formatBytes(item.after)}`,
				});
			}
		}

		new Setting(contentEl)
			.addButton((button) =>
				button.setButtonText("Copy report").onClick(() => {
					void navigator.clipboard.writeText(this.asText());
					new Notice("Report copied.");
				})
			)
			.addButton((button) => button.setButtonText("Close").setCta().onClick(() => this.close()));
	}

	private section(
		title: string,
		items: { name: string; reason: string; size: number }[],
		cls: string,
		open: boolean
	): void {
		if (items.length === 0) return;
		const details = this.contentEl.createEl("details", { cls: `photo-slimmer-details ${cls}` });
		if (open) details.setAttr("open", "");
		details.createEl("summary", { text: `${title} (${items.length})` });
		const list = details.createDiv({ cls: "photo-slimmer-list" });
		for (const item of items) {
			const row = list.createDiv({ cls: "photo-slimmer-row photo-slimmer-reasoned" });
			row.createSpan({ cls: "photo-slimmer-name", text: item.name });
			row.createSpan({ cls: "photo-slimmer-reason", text: item.reason });
		}
	}

	/** Plain text, so a long list can leave this window and be searched. */
	private asText(): string {
		const { done, skipped, failed } = this.report;
		const before = done.reduce((sum, d) => sum + d.before, 0);
		const after = done.reduce((sum, d) => sum + d.after, 0);
		const lines = [
			`Photo Slimmer — ${done.length} compressed, ${skipped.length} left alone, ${failed.length} failed`,
			`${formatBytes(before)} → ${formatBytes(after)} (saved ${formatBytes(before - after)})`,
		];
		if (failed.length) {
			lines.push("", "Could not be replaced:");
			for (const f of failed) lines.push(`  ${f.path} — ${f.reason}`);
		}
		for (const [kind, items] of groupByKind(skipped)) {
			lines.push("", `Left alone — ${KIND_TITLES[kind].toLowerCase()} (${items.length}):`);
			for (const s of items) lines.push(`  ${s.path} — ${s.reason}`);
		}
		if (done.length) {
			lines.push("", "Compressed:");
			for (const d of done) {
				const was = d.renamedFrom ? `, was ${d.renamedFrom}` : "";
				lines.push(
					`  ${d.path} — ${formatBytes(d.before)} → ${formatBytes(d.after)} (${d.dimensions}${was})`
				);
			}
		}
		return lines.join("\n");
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/** Skipped images by kind, in the order the kinds are declared in `KIND_TITLES`. */
function groupByKind(items: Left[]): [LeftKind, Left[]][] {
	const groups = new Map<LeftKind, Left[]>();
	for (const kind of Object.keys(KIND_TITLES) as LeftKind[]) groups.set(kind, []);
	for (const item of items) groups.get(item.kind)?.push(item);
	return [...groups].filter(([, list]) => list.length > 0);
}

function stat(parent: HTMLElement, label: string, value: string): void {
	const cell = parent.createDiv({ cls: "photo-slimmer-stat" });
	cell.createDiv({ cls: "photo-slimmer-stat-value", text: value });
	cell.createDiv({ cls: "photo-slimmer-stat-label", text: label });
}
