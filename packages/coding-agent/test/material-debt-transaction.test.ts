import { createPool, type Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MySqlDebtRepository } from "../src/extensions/info-debt/db.ts";
import type { DebtItem } from "../src/extensions/info-debt/types.ts";

vi.mock("mysql2/promise", () => ({ createPool: vi.fn() }));

describe("debt and material atomic capture", () => {
	it("rolls back the debt when saving its material fails", async () => {
		const events: string[] = [];
		const connection = {
			execute: vi.fn(async (sql: string) => {
				if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }], []];
				if (sql.startsWith("INSERT INTO debt_items")) events.push("insert-debt");
				return [[], []];
			}),
			beginTransaction: vi.fn(async () => {
				events.push("begin");
			}),
			commit: vi.fn(async () => {
				events.push("commit");
			}),
			rollback: vi.fn(async () => {
				events.push("rollback");
			}),
			release: vi.fn(),
		};
		const pool = {
			execute: vi.fn().mockResolvedValue([[], []]),
			getConnection: vi.fn().mockResolvedValue(connection),
			end: vi.fn(),
		};
		vi.mocked(createPool).mockReturnValue(pool as unknown as Pool);
		const repository = new MySqlDebtRepository({ host: "unused", port: 3306, user: "unused", database: "unused" });
		const capture = vi.spyOn(repository.materials, "captureDebt").mockImplementation(async () => {
			events.push("save-material");
			throw new Error("material persistence failed");
		});
		const debt: DebtItem = {
			id: "debt",
			title: "Article",
			sourceType: "web",
			sourceUrl: "https://example.com/",
			debtType: "reading",
			status: "inbox",
			priority: 3,
			createdAt: 1,
			updatedAt: 1,
		};
		await expect(repository.create(debt)).rejects.toThrow("material persistence failed");
		expect(capture).toHaveBeenCalledWith(connection, debt);
		expect(events).toEqual(["begin", "insert-debt", "save-material", "rollback"]);
		expect(connection.commit).not.toHaveBeenCalled();
		await repository.close();
	});
});
