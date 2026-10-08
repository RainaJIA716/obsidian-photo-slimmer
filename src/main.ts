import {
	Notice,
	Plugin,
	TAbstractFile,
	TFile,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	requireApiVersion,
} from "obsidian";
import { canEncodeWebp } from "./compress";
import { flushOpenNotes } from "./editors";
import { PreviewModal, ProgressModal, ReportModal } from "./dialogs";
import { LinkIndex } from "./linkindex";
import { LeftAloneMemory } from "./memory";
import { InternalWrites } from "./replace";
import { LASTING_KINDS, findCandidates, limitCandidates, runCompression } from "./run";
import { DEFAULT_SETTINGS, ICON } from "./settings";
import type { SlimmerSettings } from "./settings";

export default class PhotoSlimmerPlugin extends Plugin {
	settings!: SlimmerSettings;
	private readonly internal = new InternalWrites();
	private readonly linkIndex = new LinkIndex(this.app);
	private leftAlone!: LeftAloneMemory;
	private running = false;

	async onload(): Promise<void> {
		await this.loadSettings();
		this.leftAlone = new LeftAloneMemory(
			this.app.vault.adapter,
			`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/left-alone.json`
		);
		await this.leftAlone.load();

		// The link index is read from note text, so it follows note edits. It is
		// only ever built on demand, so a vault that never runs a compression
		// never pays for the pass over its markdown.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (isNote(file)) void this.linkIndex.reindex(file);
			})
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (isNote(file)) void this.linkIndex.reindex(file);
			})
		);
		this.registerEvent(this.app.vault.on("delete", (file) => this.linkIndex.forget(file.path)));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (isNote(file)) this.linkIndex.rename(oldPath, file);
				else this.linkIndex.forget(oldPath);
			})
		);

		this.addRibbonIcon(ICON, "Compress images to WebP", () => void this.start());
		this.addCommand({
			id: "compress-images",
			name: "Compress images to WebP",
			icon: ICON,
			callback: () => void this.start(),
		});
		this.addCommand({
			id: "retry-left-alone",
			name: "Retry images left alone earlier",
			icon: ICON,
			callback: () => void this.forgetLeftAlone(),
		});

		this.addSettingTab(new SlimmerSettingTab(this));
	}

	/**
	 * Nothing happens without this being called, and it is only ever called by a
	 * button or a command. There is no automatic path: an earlier version
	 * compressed on `create`, which put it in a race with every other plugin
	 * that touches new attachments and with the editor's own buffer.
	 */
	private async start(): Promise<void> {
		if (this.running) {
			new Notice("Photo Slimmer is already running.");
			return;
		}

		if (!(await canEncodeWebp())) {
			new Notice("Photo Slimmer: this build cannot encode WebP, so nothing was changed.");
			return;
		}

		const { candidates, remembered } = findCandidates(this.app, this.settings, (file) =>
			this.leftAlone.remembers(file, this.settings)
		);
		if (candidates.length === 0) {
			const held =
				remembered > 0
					? ` ${remembered} that an earlier run left alone are not retried; use "Retry images left alone earlier" to look at them again.`
					: "";
			new Notice(
				`Photo Slimmer: no images over ${this.settings.minSizeKb} KB left to convert.${held}`,
				remembered > 0 ? 10000 : undefined
			);
			return;
		}

		const files = limitCandidates(candidates, this.settings.maxPerRun);
		new PreviewModal(this.app, files, candidates.length, remembered, this.settings, () =>
			void this.execute(files)
		).open();
	}

	private async forgetLeftAlone(): Promise<void> {
		const count = this.leftAlone.count;
		this.leftAlone.clear();
		await this.leftAlone.save();
		new Notice(
			count > 0
				? `Photo Slimmer: the next run will look at ${count} image${count === 1 ? "" : "s"} again.`
				: "Photo Slimmer: no images were being held back."
		);
	}

	private async execute(files: TFile[]): Promise<void> {
		this.running = true;
		const progress = new ProgressModal(this.app, files.length);
		progress.open();

		try {
			// Before anything else: an open editor holds an unsaved buffer that
			// would land on top of our link rewrites later. There is always a
			// note open when someone clicks the button, and it is often one that
			// shows the very images about to be compressed.
			await flushOpenNotes(this.app);

			// Built once, here, where the cost is visible as part of a run the
			// user asked for rather than as an unexplained pause.
			await this.linkIndex.ensure();

			const report = await runCompression(
				this.app,
				files,
				this.settings,
				this.linkIndex,
				this.internal,
				{
					onProgress: (index, _total, file) => progress.update(index, file.name),
					isCancelled: () => progress.isCancelled(),
				}
			);

			// Remembered even when the run was stopped part way: each verdict
			// was reached in full, and is just as true.
			for (const item of report.skipped) {
				if (LASTING_KINDS.has(item.kind)) this.leftAlone.remember(item, this.settings);
			}
			this.leftAlone.prune((path) => this.app.vault.getAbstractFileByPath(path) !== null);
			try {
				await this.leftAlone.save();
			} catch (error) {
				console.warn("Photo Slimmer: could not save the list of images left alone", error);
			}

			progress.close();
			new ReportModal(this.app, report).open();
		} catch (error) {
			progress.close();
			console.error("Photo Slimmer: the run stopped early", error);
			new Notice(`Photo Slimmer stopped: ${String(error)}`, 15000);
		} finally {
			this.running = false;
		}
	}

	async loadSettings(): Promise<void> {
		const saved = (await this.loadData()) as Partial<SlimmerSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(saved ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}
}

function isNote(file: TAbstractFile): file is TFile {
	return file instanceof TFile && file.extension === "md";
}

class SlimmerSettingTab extends PluginSettingTab {
	constructor(private plugin: PhotoSlimmerPlugin) {
		super(plugin.app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				name: "Size threshold",
				desc: "Images at or below this size are never touched, in KB. This is about not spending time on files where the saving would be negligible — the minimum-saving setting is what prevents a pointless rewrite.",
				control: { type: "number", key: "minSizeKb", min: 0 },
			},
			{
				name: "Images per run",
				desc: "Stop after this many images each time, biggest first. 0 does the whole vault in one go. A smaller number lets you check a batch before committing to the rest; run it again to carry on where it stopped.",
				control: { type: "number", key: "maxPerRun", min: 0 },
			},
			{
				name: "Longest edge",
				desc: "Images wider or taller than this are scaled down to it, in pixels. 0 keeps the original size and only re-encodes. A very tall image is scaled by its short edge instead, which never drops below 1080.",
				control: { type: "number", key: "maxEdge", min: 0 },
			},
			{
				name: "WebP quality for PNG",
				desc: "Higher keeps more detail and produces bigger files. 90 was measured at 85% smaller than the source across a real vault. 100 is lossless. A PNG that comes out no smaller is tried once more losslessly, which suits flat screenshots.",
				control: { type: "slider", key: "quality", min: 50, max: 100, step: 1 },
			},
			{
				name: "WebP quality for JPEG",
				desc: "A JPEG has already been compressed once, so the PNG setting usually leaves it no smaller. 80 typically saves 20-35% on a JPEG at a difference that is hard to see; raise it if you can see one.",
				control: { type: "slider", key: "jpegQuality", min: 50, max: 100, step: 1 },
			},
			{
				name: "Minimum saving",
				desc: "Leave an image untouched unless converting it saves at least this much, in percent.",
				control: { type: "slider", key: "minSavingPercent", min: 0, max: 50, step: 1 },
			},
			{
				name: "The original file",
				desc: "On an iCloud vault the system trash still counts against your iCloud storage for 30 days, so keeping originals means the space is not actually freed until then.",
				control: {
					type: "dropdown",
					key: "originalHandling",
					options: {
						trash: "Move it to the system trash",
						overwrite: "Replace it, keeping no copy",
					},
				},
			},
			{
				name: "Excluded folders",
				desc: "One folder path per line. Images in these folders and their subfolders are never touched.",
				control: { type: "textarea", key: "excludedFolders", rows: 3 },
			},
		];
	}

	display(): void {
		// 1.13+ has already rendered the declarative definitions above.
		if (requireApiVersion("1.13.0")) return;

		const { containerEl } = this;
		containerEl.empty();
		const settings = this.plugin.settings;
		const save = () => void this.plugin.saveSettings();

		const number = (
			name: string,
			desc: string,
			key: "minSizeKb" | "maxPerRun" | "maxEdge"
		) =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addText((text) =>
					text.setValue(String(settings[key])).onChange((value) => {
						const parsed = Number(value);
						if (Number.isFinite(parsed) && parsed >= 0) {
							settings[key] = parsed;
							save();
						}
					})
				);

		number("Size threshold", "Images at or below this size are never touched, in KB.", "minSizeKb");
		number(
			"Images per run",
			"Stop after this many images each time, biggest first. 0 does the whole vault in one go.",
			"maxPerRun"
		);
		number(
			"Longest edge",
			"Images wider or taller than this are scaled down to it, in pixels. 0 keeps the original size.",
			"maxEdge"
		);

		const quality = (name: string, desc: string, key: "quality" | "jpegQuality") =>
			new Setting(containerEl)
				.setName(name)
				.setDesc(desc)
				.addSlider((slider) =>
					slider
						.setLimits(50, 100, 1)
						.setValue(settings[key])
						.onChange((value) => {
							settings[key] = value;
							save();
						})
				);

		quality(
			"WebP quality for PNG",
			"Higher keeps more detail and produces bigger files. 100 is lossless.",
			"quality"
		);
		quality(
			"WebP quality for JPEG",
			"A JPEG has already been compressed once, so it needs a lower setting to get any smaller.",
			"jpegQuality"
		);

		new Setting(containerEl)
			.setName("Minimum saving")
			.setDesc("Leave an image untouched unless converting it saves at least this much, in percent.")
			.addSlider((slider) =>
				slider
					.setLimits(0, 50, 1)
					.setValue(settings.minSavingPercent)
					.onChange((value) => {
						settings.minSavingPercent = value;
						save();
					})
			);

		new Setting(containerEl)
			.setName("The original file")
			.setDesc(
				"On an iCloud vault the system trash still counts against your iCloud storage for 30 days."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("trash", "Move it to the system trash")
					.addOption("overwrite", "Replace it, keeping no copy")
					.setValue(settings.originalHandling)
					.onChange((value) => {
						settings.originalHandling = value as SlimmerSettings["originalHandling"];
						save();
					})
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One folder path per line.")
			.addTextArea((area) =>
				area.setValue(settings.excludedFolders).onChange((value) => {
					settings.excludedFolders = value;
					save();
				})
			);
	}
}
