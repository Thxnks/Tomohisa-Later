import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import { MySqlMaterialRepository } from "../src/materials/repository.ts";
import { searchExcerpt, searchOptions } from "../src/materials/search.ts";

describe("material keyword evidence", () => {
	it("preserves exact text and UTF-16 offsets around Chinese, emoji and literal metacharacters", () => {
		const content = `开头😀${"前文".repeat(100)} Agent.Memory 版本_100% 后续正文`;
		const result = searchExcerpt(content, ["agent.memory", "版本_100%"], 80);
		expect(result.excerpt).toContain("Agent.Memory");
		expect(result.excerpt).toContain("版本_100%");
		expect(content.slice(result.offset, result.offset + result.excerpt.length)).toBe(result.excerpt);
		expect(result.totalLength).toBe(content.length);
		expect(searchExcerpt("abc 😀 def", ["😀"], 4).excerpt).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
	});

	it.each([
		{ query: " " },
		{ query: "x", limit: 0 },
		{ query: "x", limit: 21 },
		{ query: "x", excerptLength: 1001 },
		{ query: "x ".repeat(257) },
		{ query: "1 2 3 4 5 6 7 8 9" },
	])("rejects invalid bounded search input: %j", (input) => {
		expect(() => searchOptions(input)).toThrow();
	});

	it("searches current evidence with literal bound parameters and returns bounded citations", async () => {
		const content = `${"引言".repeat(100)} Agent.Memory 版本_100% 原始证据`;
		const execute = vi.fn().mockResolvedValue([
			[
				{
					material_id: "source",
					title: "Technical note",
					url: "https://example.com/note",
					source_type: "xiaohongshu",
					kind: "snapshot",
					evidence_id: "immutable-snapshot",
					asset_id: null,
					content,
					extractor: "capture",
					created_at: 1,
				},
				{
					material_id: "source",
					title: "Technical note",
					url: "https://example.com/note",
					source_type: "xiaohongshu",
					kind: "image_text",
					evidence_id: "ocr",
					asset_id: "image",
					content: "Agent.Memory 版本_100%",
					extractor: "vision-v1",
					created_at: 2,
				},
			],
			[],
		]);
		const repo = new MySqlMaterialRepository({ execute } as unknown as Pool, async () => {});
		const hits = await repo.search({
			query: "Agent.Memory 版本_100%",
			project: "project",
			sourceType: "xiaohongshu",
			materialId: "source",
			excerptLength: 60,
			limit: 2,
		});
		expect(execute.mock.calls[0][0]).toContain("s.id = m.latest_snapshot_id");
		expect(execute.mock.calls[0][0]).toContain("NOT EXISTS");
		expect(execute.mock.calls[0][0]).toContain("d.project = ?");
		expect(execute.mock.calls[0][1]).toEqual([
			"Agent.Memory",
			"Agent.Memory",
			"版本_100%",
			"版本_100%",
			"xiaohongshu",
			"source",
			"project",
			2,
		]);
		expect(hits[0]).toMatchObject({ materialId: "source", snapshotId: "immutable-snapshot", kind: "snapshot" });
		expect(hits[0].excerpt.length).toBeLessThanOrEqual(60);
		expect(content.slice(hits[0].offset, hits[0].offset + hits[0].excerpt.length)).toBe(hits[0].excerpt);
		expect(hits[1]).toMatchObject({ imageTextId: "ocr", assetId: "image", kind: "image_text" });
		expect(hits[1].snapshotId).toBeUndefined();
	});

	it("makes historical search explicit and keeps metadata-only matches separate from evidence", async () => {
		const execute = vi.fn().mockResolvedValue([
			[
				{
					material_id: "link",
					title: "Unread Agent note",
					source_type: "web",
					kind: "metadata",
					evidence_id: null,
					asset_id: null,
					content: "",
					extractor: null,
					url: null,
					created_at: 1,
				},
			],
			[],
		]);
		const hits = await new MySqlMaterialRepository({ execute } as unknown as Pool, async () => {}).search({
			query: "Agent",
			includeHistory: true,
		});
		expect(execute.mock.calls[0][0]).not.toContain("s.id = m.latest_snapshot_id");
		expect(execute.mock.calls[0][0]).not.toContain("NOT EXISTS");
		expect(hits[0]).toMatchObject({ kind: "metadata", excerpt: "", totalLength: 0 });
		expect(hits[0].snapshotId).toBeUndefined();
	});

	it("rejects image text attached to another material and does not alter original snapshots", async () => {
		const connection = {
			execute: vi.fn().mockResolvedValue([[], []]),
			beginTransaction: vi.fn(),
			commit: vi.fn(),
			rollback: vi.fn(),
			release: vi.fn(),
		};
		const pool = { getConnection: vi.fn().mockResolvedValue(connection) };
		await expect(
			new MySqlMaterialRepository(pool as unknown as Pool, async () => {}).saveImageText(
				"other",
				"asset",
				"Derived text",
				"vision-v1",
			),
		).rejects.toThrow("does not belong");
		expect(connection.execute).toHaveBeenCalledOnce();
		expect(connection.rollback).toHaveBeenCalledOnce();
		expect(connection.commit).not.toHaveBeenCalled();
	});
});
