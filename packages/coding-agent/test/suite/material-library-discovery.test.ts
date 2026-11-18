import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DebtRepository } from "../../src/extensions/info-debt/db.ts";
import { registerDebtTools } from "../../src/extensions/info-debt/tools.ts";
import materialsExtension from "../../src/extensions/materials/index.ts";
import { registerSavedImportTools } from "../../src/extensions/materials/saved-tools.ts";
import type { MaterialCollector } from "../../src/materials/collector.ts";
import type { SavedImport, SavedImportRepository } from "../../src/materials/saved-types.ts";
import type { Material, MaterialRepository } from "../../src/materials/types.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];
afterEach(() => {
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

describe("independent source library discovery", () => {
	it.each([
		["上次收藏了啥", "list_materials", { limit: 10 }],
		["上次小红书收藏导入了哪些笔记", "get_saved_import", {}],
	] as const)("exposes the correct source tools and query guidance for %s", async (question, tool, args) => {
		const sources: Material[] = Array.from({ length: 10 }, (_, index) => ({
			id: `source-${index}`,
			kind: "link",
			title: `Imported fixture ${index}`,
			sourceType: "xiaohongshu",
			url: `https://example.com/${index}`,
			createdAt: index + 1,
			updatedAt: index + 1,
		}));
		const listSources = vi.fn().mockResolvedValue(sources);
		const listDebts = vi.fn().mockResolvedValue([]);
		const materials = { list: listSources } as unknown as MaterialRepository;
		const debts = { list: listDebts } as unknown as DebtRepository;
		const job: SavedImport = {
			id: "fixture-import",
			status: "completed",
			requestedLimit: 20,
			createdAt: 1,
			updatedAt: 2,
			items: sources.map((source, position) => ({
				id: `note-${position}`,
				position,
				title: source.title,
				url: source.url!,
				status: "imported",
				materialId: source.id,
				issues: [],
			})),
		};
		const getImport = vi.fn().mockResolvedValue(job);
		const imports = { get: getImport } as unknown as SavedImportRepository;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => registerDebtTools(pi, debts),
				(pi) => materialsExtension(pi, materials),
				(pi) => registerSavedImportTools(pi, imports, materials, {} as MaterialCollector),
			],
		});
		harnesses.push(harness);
		harness.setResponses([
			(context) => {
				const names = (context.tools ?? []).map((item) => item.name);
				for (const name of ["list_materials", "search_materials", "get_saved_import", "list_debts"])
					expect(names).toContain(name);
				// Guard the provider boundary, not only registration metadata: the model must receive the routing guidance.
				expect(context.systemPrompt).toContain("上次收藏了啥");
				expect(context.systemPrompt).toContain("get_saved_import");
				expect(context.systemPrompt).toContain("independently of business tasks");
				return fauxAssistantMessage(fauxToolCall(tool, args), { stopReason: "toolUse" });
			},
			(context) => {
				const result = context.messages.find((message) => message.role === "toolResult");
				expect(result?.role).toBe("toolResult");
				const text = getMessageText(result);
				for (const source of sources) expect(text).toContain(source.title);
				if (tool === "get_saved_import")
					expect(JSON.parse(text)).toMatchObject({
						enumeratedCount: 10,
						requestedLimit: 20,
						counts: { imported: 10 },
						libraryCoverage: "unknown",
					});
				return fauxAssistantMessage("Synthetic imported sources are available independently of debt.");
			},
		]);
		await harness.session.prompt(question);
		expect(listDebts).not.toHaveBeenCalled();
		if (tool === "list_materials") expect(listSources).toHaveBeenCalledWith(10, undefined);
		else expect(getImport).toHaveBeenCalledWith(undefined);
	});
});
