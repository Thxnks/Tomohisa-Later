import { afterEach, describe, expect, it } from "vitest";
import type { DebtFilter, DebtRepository } from "../src/extensions/info-debt/db.ts";
import { DebtHttpServer, parseInfoDebtHttpPort } from "../src/extensions/info-debt/http/server.ts";
import type { DebtItem } from "../src/extensions/info-debt/types.ts";

class CaptureRepositoryStub implements DebtRepository {
	readonly items: DebtItem[] = [];

	async close(): Promise<void> {}
	async create(item: DebtItem): Promise<void> {
		this.items.push(structuredClone(item));
	}
	async get(_id: string): Promise<DebtItem | undefined> {
		return undefined;
	}
	async listByIdPrefix(_prefix: string): Promise<DebtItem[]> {
		return [];
	}
	async list(_filter?: DebtFilter): Promise<DebtItem[]> {
		return [];
	}
	async listRevisitDue(_now: number, _limit?: number): Promise<DebtItem[]> {
		return [];
	}
	async listReviewCandidates(_now: number, _limit?: number): Promise<DebtItem[]> {
		return [];
	}
	async search(_query: string, _filter?: DebtFilter): Promise<DebtItem[]> {
		return [];
	}
	async update(_id: string, _patch: Partial<DebtItem>): Promise<DebtItem | undefined> {
		return undefined;
	}
	async resolve(_id: string, _note?: string): Promise<DebtItem | undefined> {
		return undefined;
	}
}

const servers: DebtHttpServer[] = [];

afterEach(async () => {
	await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function startServer(repository: DebtRepository): Promise<string> {
	const server = new DebtHttpServer({ repository, port: 0 });
	servers.push(server);
	const address = await server.start();
	return `http://${address.host}:${address.port}`;
}

describe("Information Debt HTTP API", () => {
	it("reports health", async () => {
		const baseUrl = await startServer(new CaptureRepositoryStub());
		const response = await fetch(`${baseUrl}/health`);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ status: "ok" });
	});

	it("captures URL, title, and why_saved from a Chromium extension", async () => {
		const repository = new CaptureRepositoryStub();
		const baseUrl = await startServer(repository);
		const response = await fetch(`${baseUrl}/v1/debts`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: "chrome-extension://abcdefghijklmnop",
			},
			body: JSON.stringify({
				url: "https://example.com/article",
				title: "Example article",
				why_saved: "Relevant to the current research project",
			}),
		});

		expect(response.status).toBe(201);
		expect(response.headers.get("access-control-allow-origin")).toBe("chrome-extension://abcdefghijklmnop");
		expect(await response.json()).toMatchObject({
			debt: { title: "Example article", status: "inbox" },
		});
		expect(repository.items).toHaveLength(1);
		expect(repository.items[0]).toMatchObject({
			title: "Example article",
			sourceType: "web",
			sourceUrl: "https://example.com/article",
			debtType: "discovery",
			whySaved: "Relevant to the current research project",
			status: "inbox",
			priority: 3,
		});
	});

	it("rejects ordinary website origins", async () => {
		const baseUrl = await startServer(new CaptureRepositoryStub());
		const response = await fetch(`${baseUrl}/health`, {
			headers: { Origin: "https://example.com" },
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({ error: { code: "origin_not_allowed" } });
	});

	it("rejects invalid capture input", async () => {
		const repository = new CaptureRepositoryStub();
		const baseUrl = await startServer(repository);
		const response = await fetch(`${baseUrl}/v1/debts`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "file:///tmp/note", title: "Note", why_saved: "Read later" }),
		});

		expect(response.status).toBe(400);
		expect(repository.items).toEqual([]);
	});

	it("validates configured ports", () => {
		expect(parseInfoDebtHttpPort(undefined)).toBe(43_127);
		expect(parseInfoDebtHttpPort("44000")).toBe(44_000);
		expect(() => parseInfoDebtHttpPort("0")).toThrow(/1 to 65535/);
	});
});
