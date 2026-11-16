import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "../src/core/extensions/types.ts";
import materialsExtension from "../src/extensions/materials/index.ts";
import type { MaterialRepository } from "../src/materials/types.ts";

describe("material extension", () => {
	it("bounds evidence output and preserves the historical snapshot ID and offsets", async () => {
		const tools = new Map<string, ToolDefinition>();
		const api = { registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI;
		const repository: MaterialRepository = {
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
			"save_material",
			"list_materials",
			"get_material",
			"save_material_snapshot",
			"save_material_file",
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
	});
});
