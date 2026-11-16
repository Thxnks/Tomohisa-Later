import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Pool, PoolConnection } from "mysql2/promise";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalAssetStore } from "../src/materials/asset-store.ts";
import { MySqlMaterialRepository, migrateMaterials, normalizeMaterial } from "../src/materials/repository.ts";
import { MAX_MATERIAL_FILE_BYTES, MaterialService } from "../src/materials/service.ts";
import type { Material, MaterialAsset, MaterialRepository } from "../src/materials/types.ts";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function directory(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-material-test-"));
	directories.push(dir);
	return dir;
}

function repositoryStub(): MaterialRepository {
	return {
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
}

function databaseStub() {
	const connection = {
		execute: vi.fn().mockResolvedValue([[], []]),
		beginTransaction: vi.fn().mockResolvedValue(undefined),
		commit: vi.fn().mockResolvedValue(undefined),
		rollback: vi.fn().mockResolvedValue(undefined),
		release: vi.fn(),
	};
	const pool = { getConnection: vi.fn().mockResolvedValue(connection), execute: vi.fn().mockResolvedValue([[], []]) };
	return { connection, pool, database: pool as unknown as Pool };
}

describe("material identity", () => {
	it("normalizes host and default port without removing signed parameters or anchors", () => {
		const first = normalizeMaterial({
			kind: "link",
			title: "First",
			url: "https://EXAMPLE.com:443/a?xsec_token=abc#part-2",
		});
		const second = normalizeMaterial({
			kind: "link",
			title: "Other title",
			url: "https://example.com/a?xsec_token=abc#part-2",
		});
		expect(first.identityHash).toBe(second.identityHash);
		expect(first.url).toBe("https://example.com/a?xsec_token=abc#part-2");
		expect(
			normalizeMaterial({ ...second, url: "https://example.com/a?xsec_token=def#part-2" }).identityHash,
		).not.toBe(first.identityHash);
	});

	it("keeps text bytes intact and rejects invalid links", () => {
		const text = "first\n\nsecond\n";
		expect(normalizeMaterial({ kind: "text", title: "Text", text }).text).toBe(text);
		for (const url of ["file:///tmp/source", "javascript:alert(1)", "https://user:secret@example.com/"]) {
			expect(() => normalizeMaterial({ kind: "link", title: "Bad", url })).toThrow();
		}
		expect(() => normalizeMaterial({ kind: "text", title: "Blank", text: " " })).toThrow();
	});
});

describe("local asset store", () => {
	it("deduplicates concurrent writes, retains exact bytes, and removes staging files", async () => {
		const root = await directory();
		const store = new LocalAssetStore(root);
		const content = Buffer.from("source bytes\n");
		const results = await Promise.all(Array.from({ length: 4 }, () => store.put(content)));
		expect(new Set(results.map((r) => r.sha256)).size).toBe(1);
		expect(await store.read(results[0].sha256)).toEqual(content);
		expect(await readdir(join(root, results[0].sha256.slice(0, 2)))).toEqual([results[0].sha256]);
		await expect(store.read("../../outside")).rejects.toThrow("Invalid asset hash");
	});

	it("detects corrupted blobs on reads and repeated imports", async () => {
		const root = await directory();
		const store = new LocalAssetStore(root);
		const original = Buffer.from("original");
		const blob = await store.put(original);
		await writeFile(join(root, blob.sha256.slice(0, 2), blob.sha256), "changed");
		await expect(store.read(blob.sha256)).rejects.toThrow("integrity");
		await expect(store.put(original)).rejects.toThrow("integrity");
	});
});

describe("material files", () => {
	it("reuses an imported image when a later capture reports another position", async () => {
		const root = await directory();
		const filePath = join(root, "image.png");
		const bytes = Buffer.from("same image bytes");
		await writeFile(filePath, bytes);
		const repository = repositoryStub();
		const material: Material = {
			id: "source",
			kind: "link",
			title: "Source",
			sourceType: "web",
			createdAt: 1,
			updatedAt: 1,
		};
		const asset: MaterialAsset = {
			id: "existing-image",
			materialId: material.id,
			role: "image",
			position: 0,
			sha256: createHash("sha256").update(bytes).digest("hex"),
			size: bytes.length,
			contentType: "image/png",
			fileName: "image.png",
			createdAt: 1,
		};
		vi.mocked(repository.get).mockResolvedValue({ material, assets: [asset] });
		const result = await new MaterialService(repository, new LocalAssetStore(join(root, "assets"))).saveFile({
			filePath,
			materialId: material.id,
			contentType: "image/png",
			role: "image",
			position: 4,
			reuseExisting: true,
		});
		expect(result.asset.id).toBe("existing-image");
		expect(repository.attachAsset).not.toHaveBeenCalled();
	});
	it("copies a local file without changing its source and preserves image order", async () => {
		const root = await directory();
		const filePath = join(root, "third.png");
		const content = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
		await writeFile(filePath, content);
		const repository = repositoryStub();
		const material: Material = {
			id: "article",
			kind: "link",
			title: "Article",
			sourceType: "web",
			createdAt: 1,
			updatedAt: 1,
		};
		vi.mocked(repository.get).mockResolvedValue({ material, assets: [] });
		vi.mocked(repository.attachAsset).mockImplementation(async (asset) => asset);
		const store = new LocalAssetStore(join(root, "assets"));
		const saved = await new MaterialService(repository, store).saveFile({
			filePath,
			materialId: material.id,
			contentType: "image/png",
			role: "image",
			position: 2,
			sourceUrl: "https://example.com/image.png",
		});
		expect(saved.asset).toMatchObject({ materialId: material.id, role: "image", position: 2, size: content.length });
		expect(await store.read(saved.asset.sha256)).toEqual(content);
		expect(await readFile(filePath)).toEqual(content);
	});

	it("rejects missing parents and oversized files before publishing blobs", async () => {
		const root = await directory();
		const repository = repositoryStub();
		const store = new LocalAssetStore(join(root, "assets"));
		const put = vi.spyOn(store, "put");
		const service = new MaterialService(repository, store);
		vi.mocked(repository.get).mockResolvedValue(undefined);
		await expect(
			service.saveFile({ filePath: "not-opened", materialId: "missing", contentType: "image/png" }),
		).rejects.toThrow("Material not found");
		const filePath = join(root, "large.pdf");
		await writeFile(filePath, Buffer.alloc(MAX_MATERIAL_FILE_BYTES + 1));
		await expect(service.saveFile({ filePath, contentType: "application/pdf" })).rejects.toThrow("20 MiB");
		expect(put).not.toHaveBeenCalled();
	});

	it("keeps a published blob intact when database persistence fails", async () => {
		const root = await directory();
		const filePath = join(root, "source.txt");
		await writeFile(filePath, "evidence");
		const repository = repositoryStub();
		vi.mocked(repository.createAssetMaterial).mockRejectedValue(new Error("database offline"));
		const store = new LocalAssetStore(join(root, "assets"));
		await expect(
			new MaterialService(repository, store).saveFile({ filePath, contentType: "text/plain" }),
		).rejects.toThrow("database offline");
		const hash = createHash("sha256").update("evidence").digest("hex");
		expect((await store.read(hash)).toString()).toBe("evidence");
		expect((await readFile(filePath)).toString()).toBe("evidence");
	});
});

describe("material database transactions", () => {
	it("adds collection storage when upgrading schema version 1", async () => {
		const { database, connection } = databaseStub();
		connection.execute
			.mockResolvedValueOnce([[{ acquired: 1 }], []])
			.mockResolvedValueOnce([[], []])
			.mockResolvedValueOnce([[{ value: "1" }], []]);
		await migrateMaterials(database);
		const sql = connection.execute.mock.calls.map(([statement]) => String(statement));
		expect(sql.some((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS material_collections"))).toBe(
			true,
		);
		expect(connection.execute).toHaveBeenCalledWith(expect.stringContaining("INSERT INTO material_meta"), ["3", "3"]);
		expect(connection.release).toHaveBeenCalledOnce();
	});

	it("does not overwrite an already finished collection", async () => {
		const { database, pool } = databaseStub();
		pool.execute.mockResolvedValueOnce([{ affectedRows: 0 }, []]);
		await expect(
			new MySqlMaterialRepository(database, async () => {}).finishCollection("finished", {
				status: "partial",
				sources: [],
				imageCount: 0,
				images: [],
				issues: ["NEED_LOGIN"],
			}),
		).rejects.toThrow("already finished");
	});
	it("rolls back a snapshot when its material is missing", async () => {
		const { database, connection } = databaseStub();
		const repository = new MySqlMaterialRepository(database, async () => {});
		await expect(
			repository.saveSnapshot("missing", { content: "evidence", contentType: "text/plain", extractor: "test-v1" }),
		).rejects.toThrow("Material not found");
		expect(connection.rollback).toHaveBeenCalledOnce();
		expect(connection.commit).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalledOnce();
	});

	it("does not replace an attachment already used at the same image position", async () => {
		const { database, connection } = databaseStub();
		connection.execute.mockResolvedValueOnce([[{ id: "material" }], []]).mockResolvedValueOnce([
			[
				{
					sha256: "a".repeat(64),
					content_type: "image/png",
				},
			],
			[],
		]);
		const asset: MaterialAsset = {
			id: "new",
			materialId: "material",
			sha256: "b".repeat(64),
			size: 8,
			contentType: "image/png",
			fileName: "new.png",
			role: "image",
			position: 0,
			createdAt: 1,
		};
		await expect(new MySqlMaterialRepository(database, async () => {}).attachAsset(asset)).rejects.toThrow(
			"immutable asset",
		);
		expect(connection.rollback).toHaveBeenCalledOnce();
		expect(connection.execute).toHaveBeenCalledTimes(2);
	});

	it("does not manufacture a material for a debt without source content", async () => {
		const { database, connection } = databaseStub();
		await new MySqlMaterialRepository(database, async () => {}).captureDebt(connection as unknown as PoolConnection, {
			id: "task",
			title: "Make a decision",
			sourceType: "manual",
			debtType: "decision",
			status: "inbox",
			priority: 3,
			createdAt: 1,
			updatedAt: 1,
		});
		expect(connection.execute).not.toHaveBeenCalled();
	});

	it("releases the migration lock on failure and does not advance the schema version", async () => {
		const { database, connection } = databaseStub();
		connection.execute
			.mockResolvedValueOnce([[{ acquired: 1 }], []])
			.mockResolvedValueOnce([[], []])
			.mockResolvedValueOnce([[], []])
			.mockRejectedValueOnce(new Error("DDL failed"));
		await expect(migrateMaterials(database)).rejects.toThrow("DDL failed");
		expect(connection.execute).toHaveBeenLastCalledWith("SELECT RELEASE_LOCK('pi_material_schema')");
		expect(connection.execute.mock.calls.some(([sql]) => String(sql).startsWith("INSERT INTO material_meta"))).toBe(
			false,
		);
		expect(connection.release).toHaveBeenCalledOnce();
	});

	it("refuses a newer schema instead of rewriting its version", async () => {
		const { database, connection } = databaseStub();
		connection.execute
			.mockResolvedValueOnce([[{ acquired: 1 }], []])
			.mockResolvedValueOnce([[], []])
			.mockResolvedValueOnce([[{ value: "99" }], []]);
		await expect(migrateMaterials(database)).rejects.toThrow("Unsupported material schema version: 99");
		expect(connection.release).toHaveBeenCalledOnce();
	});
});
