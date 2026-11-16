import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAssetStore } from "../src/materials/asset-store.ts";
import type { CollectionCommand } from "../src/materials/collection-command.ts";
import { MacOSImageTextRecognizer, MaterialImageTextService } from "../src/materials/image-text.ts";
import type { MaterialRepository } from "../src/materials/types.ts";

const directories: string[] = [];
afterEach(async () => {
	for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("local image transcription", () => {
	it("uses local Vision with Chinese and English, disables language correction and removes staging scripts", async () => {
		let script = "";
		const command = vi.fn<CollectionCommand>(async (binary, args) => {
			expect(binary).toBe("/usr/bin/xcrun");
			expect(args[0]).toBe("swift");
			script = args[1];
			const source = await readFile(script, "utf8");
			expect(source).toContain('["zh-Hans", "en-US"]');
			expect(source).toContain("usesLanguageCorrection = false");
			return { code: 0, stdout: JSON.stringify({ text: "Agent Memory\n原图文字" }) };
		});
		expect(await new MacOSImageTextRecognizer(command, "darwin").recognize("/image.png")).toBe(
			"Agent Memory\n原图文字",
		);
		await expect(stat(script)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it.each(["not-json", '{"text": 42}', '{"other": "value"}'])(
		"rejects malformed recognizer output",
		async (stdout) => {
			await expect(
				new MacOSImageTextRecognizer(async () => ({ code: 0, stdout }), "darwin").recognize("/image"),
			).rejects.toMatchObject({ code: "INVALID_IMAGE_TEXT_RESPONSE" });
		},
	);

	it("reports unsupported platforms without executing a command", async () => {
		const command = vi.fn<CollectionCommand>();
		await expect(new MacOSImageTextRecognizer(command, "linux").recognize("/image")).rejects.toMatchObject({
			code: "IMAGE_TEXT_REQUIRES_MACOS",
		});
		expect(command).not.toHaveBeenCalled();
	});

	it("links derived text to verified image bytes, preserves snapshots, and reuses the extractor result", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-image-text-test-"));
		directories.push(directory);
		const store = new LocalAssetStore(directory);
		const blob = await store.put(Buffer.from("verified image bytes"));
		const saveImageText = vi.fn<MaterialRepository["saveImageText"]>(
			async (materialId, assetId, content, extractor) => ({
				id: "derived",
				materialId,
				assetId,
				content,
				extractor,
				contentHash: "hash",
				createdAt: 1,
			}),
		);
		const findImageText = vi.fn<MaterialRepository["findImageText"]>().mockResolvedValue(undefined);
		const saveSnapshot = vi.fn();
		const repository = {
			get: vi.fn().mockResolvedValue({
				material: { id: "source" },
				assets: [{ id: "image", materialId: "source", ...blob, contentType: "image/png" }],
			}),
			findImageText,
			saveImageText,
			saveSnapshot,
		} as unknown as MaterialRepository;
		let staging = "";
		const recognize = vi.fn(async (filePath: string) => {
			staging = filePath;
			expect((await readFile(filePath)).toString()).toBe("verified image bytes");
			return "原图文字";
		});
		const service = new MaterialImageTextService(repository, store, { extractor: "test-v1", recognize });
		const first = await service.extract("source", "image");
		expect(first.reused).toBe(false);
		expect(saveImageText).toHaveBeenCalledWith("source", "image", "原图文字", "test-v1");
		expect(saveSnapshot).not.toHaveBeenCalled();
		await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
		findImageText.mockResolvedValue(first.imageText);
		expect((await service.extract("source", "image")).reused).toBe(true);
		expect(recognize).toHaveBeenCalledOnce();
		expect(saveImageText).toHaveBeenCalledOnce();
		await expect(service.extract("source", "not-owned")).rejects.toThrow("belonging");
		expect(recognize).toHaveBeenCalledOnce();
	});
});
