import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import materialsExtension from "../src/extensions/materials/index.ts";
import type { MaterialRepository } from "../src/materials/types.ts";

describe("material extension", () => {
	it("bounds evidence output and preserves the historical snapshot ID and offsets", async () => {
		const tools = new Map<string, ToolDefinition>();
		const api = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
		const repository: MaterialRepository = {
			search: vi.fn(),
			saveImageText: vi.fn(),
			getImageText: vi.fn(),
			findImageText: vi.fn(),
			beginCollection: vi.fn(),
			finishCollection: vi.fn(),
			save: vi.fn(),
			get: vi.fn(),
			list: vi.fn(),
			findForDebt: vi.fn(),
			importDebt: vi.fn(),
			saveSnapshot: vi.fn(),
			getSnapshot: vi.fn(),
			createAssetMaterial: vi.fn(),
			attachAsset: vi.fn(),
		};
		vi.mocked(repository.get).mockResolvedValue({
			material: {
				id: "source",
				kind: "text",
				title: "Note",
				sourceType: "manual",
				text: "DO NOT RETURN THE ORIGINAL BODY",
				createdAt: 1,
				updatedAt: 2,
			},
			assets: [],
		});
		vi.mocked(repository.getSnapshot).mockResolvedValue({
			id: "old-snapshot",
			materialId: "source",
			content: "abcdefghij",
			contentType: "text/plain",
			contentHash: "hash",
			extractor: "test-v1",
			createdAt: 1,
		});
		materialsExtension(api, repository);
		expect([...tools.keys()]).toEqual([
			"search_materials",
			"extract_material_image_text",
			"save_material",
			"list_materials",
			"get_material",
			"save_material_snapshot",
			"save_material_file",
			"collect_material",
			"import_debt_material",
		]);
		const result = await tools
			.get("get_material")!
			.execute(
				"call",
				{ materialId: "source", snapshotId: "old-snapshot", offset: 2, length: 3 },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
		expect(repository.getSnapshot).toHaveBeenCalledWith("source", "old-snapshot");
		const text = result.content.find((part) => part.type === "text");
		if (!text || text.type !== "text") throw new Error("Expected text result");
		expect(JSON.parse(text.text)).toMatchObject({
			snapshot: { id: "old-snapshot", content: "cde", offset: 2, totalLength: 10 },
		});
		expect(text.text).not.toContain("DO NOT RETURN");
		vi.mocked(repository.getImageText).mockResolvedValue({
			id: "derived",
			materialId: "source",
			assetId: "image",
			content: "原图识别文字",
			contentHash: "hash",
			extractor: "vision-v1",
			createdAt: 1,
		});
		const derived = await tools
			.get("get_material")!
			.execute(
				"image-read",
				{ materialId: "source", imageTextId: "derived", offset: 2, length: 2 },
				undefined,
				undefined,
				{} as ExtensionContext,
			);
		const derivedText = derived.content.find((part) => part.type === "text");
		if (!derivedText || derivedText.type !== "text") throw new Error("Expected image text result");
		expect(JSON.parse(derivedText.text)).toMatchObject({
			imageText: { id: "derived", assetId: "image", content: "识别", derived: true, offset: 2 },
		});
		expect(JSON.parse(derivedText.text).snapshot).toBeUndefined();
		await expect(
			tools
				.get("get_material")!
				.execute(
					"ambiguous",
					{ materialId: "source", imageTextId: "derived", snapshotId: "original" },
					undefined,
					undefined,
					{} as ExtensionContext,
				),
		).rejects.toThrow("at most one");
		vi.mocked(repository.search).mockResolvedValue([]);
		const search = await tools
			.get("search_materials")!
			.execute("empty-search", { query: "不存在" }, undefined, undefined, {} as ExtensionContext);
		expect(search.details).toEqual({ count: 0 });
		expect(repository.search).toHaveBeenCalledWith({ query: "不存在" });
	});
});
