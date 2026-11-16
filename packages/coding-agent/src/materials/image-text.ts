import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalAssetStore } from "./asset-store.ts";
import { type CollectionCommand, CollectionError, runCollectionCommand } from "./collection-command.ts";
import type { MaterialImageText, MaterialRepository } from "./types.ts";

// Vision returns transcribed lines. It does not summarize or describe the picture.
const VISION_SCRIPT = `import Foundation
import Vision
let input = URL(fileURLWithPath: CommandLine.arguments[1])
let request = VNRecognizeTextRequest()
request.revision = VNRecognizeTextRequestRevision3
request.recognitionLevel = .accurate
request.recognitionLanguages = ["zh-Hans", "en-US"]
request.automaticallyDetectsLanguage = true
request.usesLanguageCorrection = false
do {
    try VNImageRequestHandler(url: input).perform([request])
    let lines = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }
    let data = try JSONSerialization.data(withJSONObject: ["text": lines.joined(separator: "\\n")])
    FileHandle.standardOutput.write(data)
} catch {
    exit(1)
}
`;

export interface ImageTextRecognizer {
	readonly extractor: string;
	recognize(filePath: string, signal?: AbortSignal): Promise<string>;
}

export class MacOSImageTextRecognizer implements ImageTextRecognizer {
	readonly extractor = `macos-vision-r3-v1:${release()}`;
	private readonly command: CollectionCommand;
	private readonly platform: NodeJS.Platform;

	constructor(command: CollectionCommand = runCollectionCommand, platform: NodeJS.Platform = process.platform) {
		this.command = command;
		this.platform = platform;
	}

	async recognize(filePath: string, signal?: AbortSignal): Promise<string> {
		if (this.platform !== "darwin") throw new CollectionError("IMAGE_TEXT_REQUIRES_MACOS");
		const temporary = await mkdtemp(join(tmpdir(), "pi-image-text-"));
		try {
			const script = join(temporary, "recognize.swift");
			await writeFile(script, VISION_SCRIPT, { mode: 0o600 });
			const result = await this.command("/usr/bin/xcrun", ["swift", script, filePath], signal);
			if (result.code !== 0) throw new CollectionError("IMAGE_TEXT_RECOGNITION_FAILED");
			let parsed: unknown;
			try {
				parsed = JSON.parse(result.stdout);
			} catch {
				throw new CollectionError("INVALID_IMAGE_TEXT_RESPONSE");
			}
			if (
				!parsed ||
				typeof parsed !== "object" ||
				!("text" in parsed) ||
				typeof parsed.text !== "string" ||
				parsed.text.length > 1_000_000
			)
				throw new CollectionError("INVALID_IMAGE_TEXT_RESPONSE");
			return parsed.text;
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
}

export class MaterialImageTextService {
	private readonly repository: MaterialRepository;
	private readonly assets: LocalAssetStore;
	private readonly recognizer: ImageTextRecognizer;

	constructor(
		repository: MaterialRepository,
		assets: LocalAssetStore,
		recognizer: ImageTextRecognizer = new MacOSImageTextRecognizer(),
	) {
		this.repository = repository;
		this.assets = assets;
		this.recognizer = recognizer;
	}

	async extract(
		materialId: string,
		assetId: string,
		signal?: AbortSignal,
	): Promise<{ imageText: MaterialImageText; reused: boolean }> {
		signal?.throwIfAborted();
		const detail = await this.repository.get(materialId);
		const asset = detail?.assets.find((item) => item.id === assetId);
		if (!asset || !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(asset.contentType))
			throw new Error("A supported image asset belonging to this material is required");
		const existing = await this.repository.findImageText(materialId, assetId, this.recognizer.extractor);
		if (existing) return { imageText: existing, reused: true };
		const bytes = await this.assets.read(asset.sha256);
		if (!bytes.length || bytes.length > 20 * 1024 * 1024)
			throw new Error("Image must be non-empty and at most 20 MiB");
		// Recognize a verified private copy, so the bytes cannot change after the integrity check.
		const temporary = await mkdtemp(join(tmpdir(), "pi-image-evidence-"));
		try {
			const filePath = join(temporary, "image");
			await writeFile(filePath, bytes, { mode: 0o600 });
			const content = await this.recognizer.recognize(filePath, signal);
			signal?.throwIfAborted();
			const imageText = await this.repository.saveImageText(materialId, assetId, content, this.recognizer.extractor);
			return { imageText, reused: false };
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
}
