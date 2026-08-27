import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { Extension, ExtensionContext } from "../src/core/extensions/types.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import type { DebtFilter, DebtRepository } from "../src/extensions/info-debt/db.ts";
import infoDebtExtension from "../src/extensions/info-debt/index.ts";
import type { DebtItem } from "../src/extensions/info-debt/types.ts";

const repositories: DebtRepository[] = [];

afterEach(async () => {
	await Promise.all(repositories.splice(0).map((repository) => repository.close()));
});

class MemoryDebtRepository implements DebtRepository {
	private readonly items = new Map<string, DebtItem>();

	async close(): Promise<void> {}

	async create(item: DebtItem): Promise<void> {
		this.items.set(item.id, structuredClone(item));
	}

	async get(id: string): Promise<DebtItem | undefined> {
		const item = this.items.get(id);
		return item ? structuredClone(item) : undefined;
	}

	async listByIdPrefix(prefix: string): Promise<DebtItem[]> {
		return [...this.items.values()].filter((item) => item.id.startsWith(prefix)).map((item) => structuredClone(item));
	}

	async list(filter: DebtFilter = {}): Promise<DebtItem[]> {
		return this.filtered(filter);
	}

	async listRevisitDue(now: number, limit = 30): Promise<DebtItem[]> {
		return [...this.items.values()]
			.filter(
				(item) =>
					(item.status === "inbox" || item.status === "active") &&
					item.revisitAt !== undefined &&
					item.revisitAt <= now,
			)
			.slice(0, limit)
			.map((item) => structuredClone(item));
	}

	async listReviewCandidates(_now: number, limit = 100): Promise<DebtItem[]> {
		return [...this.items.values()].slice(0, limit).map((item) => structuredClone(item));
	}

	async search(query: string, filter: DebtFilter = {}): Promise<DebtItem[]> {
		const normalized = query.toLowerCase();
		return this.filtered(filter).filter((item) =>
			[item.title, item.summary, item.whySaved, item.project, item.nextAction, item.sourceUrl].some((value) =>
				value?.toLowerCase().includes(normalized),
			),
		);
	}

	async update(id: string, patch: Partial<DebtItem>): Promise<DebtItem | undefined> {
		const item = this.items.get(id);
		if (!item) return undefined;
		const updated = { ...item, ...patch, updatedAt: Date.now() };
		this.items.set(id, updated);
		return structuredClone(updated);
	}

	async resolve(id: string, note?: string): Promise<DebtItem | undefined> {
		return this.update(id, { status: "resolved", resolvedAt: Date.now(), resolutionNote: note });
	}

	private filtered(filter: DebtFilter): DebtItem[] {
		return [...this.items.values()]
			.filter((item) => filter.status === undefined || item.status === filter.status)
			.filter((item) => filter.statuses === undefined || filter.statuses.includes(item.status))
			.filter((item) => filter.debtType === undefined || item.debtType === filter.debtType)
			.filter((item) => filter.project === undefined || item.project === filter.project)
			.slice(0, filter.limit ?? 30)
			.map((item) => structuredClone(item));
	}
}

async function loadWithRepository(repository: DebtRepository): Promise<Extension> {
	return loadExtensionFromFactory(
		(pi) => infoDebtExtension(pi, repository),
		process.cwd(),
		createEventBus(),
		createExtensionRuntime(),
		"<inline:info-debt>",
	);
}

async function executeTool(extension: Extension, name: string, params: Record<string, unknown>): Promise<void> {
	const tool = extension.tools.get(name);
	if (!tool) throw new Error(`Tool ${name} is not registered`);
	await tool.definition.execute("test-call", params, undefined, undefined, {} as ExtensionContext);
}

describe("information debt extension", () => {
	it("is bundled and registers its tools and commands", async () => {
		expect(
			builtInExtensions.some((extension) => typeof extension !== "function" && extension.name === "info-debt"),
		).toBe(true);

		const repository = new MemoryDebtRepository();
		repositories.push(repository);
		const extension = await loadWithRepository(repository);

		expect([...extension.commands.keys()]).toEqual(["inbox", "review"]);
		expect([...extension.tools.keys()]).toEqual([
			"capture_debt",
			"list_debts",
			"get_debt",
			"search_debts",
			"update_debt",
			"resolve_debt",
		]);
	});

	it("supports capture, query, update, and resolve through tools", async () => {
		const repository = new MemoryDebtRepository();
		repositories.push(repository);
		const extension = await loadWithRepository(repository);

		await executeTool(extension, "capture_debt", {
			title: "Read the MySQL design note",
			debtType: "reading",
			sourceType: "manual",
			summary: "A note about repository boundaries",
			whySaved: "Apply it to Information Debt",
			project: "pi",
			nextAction: "Extract the migration rules",
			priority: 2,
		});

		const [captured] = await repository.list();
		expect(captured).toMatchObject({
			title: "Read the MySQL design note",
			status: "inbox",
			project: "pi",
		});

		await executeTool(extension, "list_debts", { status: "inbox" });
		await executeTool(extension, "get_debt", { id: captured.id.slice(0, 8) });
		await executeTool(extension, "search_debts", { query: "repository", project: "pi" });
		expect(await repository.search("repository", { project: "pi" })).toHaveLength(1);

		await executeTool(extension, "update_debt", {
			id: captured.id,
			status: "active",
			nextAction: "Write the repository test",
		});
		expect(await repository.get(captured.id)).toMatchObject({
			status: "active",
			nextAction: "Write the repository test",
		});

		await executeTool(extension, "resolve_debt", {
			id: captured.id.slice(0, 8),
			note: "Repository lifecycle verified",
		});
		expect(await repository.get(captured.id)).toMatchObject({
			status: "resolved",
			resolutionNote: "Repository lifecycle verified",
		});
		expect((await repository.get(captured.id))?.resolvedAt).toEqual(expect.any(Number));
	});
});
