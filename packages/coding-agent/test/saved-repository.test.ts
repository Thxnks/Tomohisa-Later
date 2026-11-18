import type { Pool } from "mysql2/promise";
import { describe, expect, it, vi } from "vitest";
import type { MySqlMaterialRepository } from "../src/materials/repository.ts";
import { MySqlSavedImportRepository } from "../src/materials/saved-repository.ts";

const note = {
	id: "1234567890abcdef12345678",
	title: "Saved note",
	url: "https://www.xiaohongshu.com/explore/1234567890abcdef12345678?xsec_token=signed",
};

function fixture() {
	const connection = {
		execute: vi.fn().mockResolvedValue([[], []]),
		beginTransaction: vi.fn(),
		commit: vi.fn(),
		rollback: vi.fn(),
		release: vi.fn(),
	};
	const pool = { getConnection: vi.fn().mockResolvedValue(connection), execute: vi.fn().mockResolvedValue([[], []]) };
	const save = vi.fn();
	const repo = new MySqlSavedImportRepository(pool as unknown as Pool, async () => {}, {
		save,
	} as unknown as MySqlMaterialRepository);
	return { repo, connection, pool, save };
}

describe("saved import persistence boundaries", () => {
	it("rejects a concurrent importer without running it, and releases the connection", async () => {
		const { repo, connection } = fixture();
		connection.execute.mockResolvedValueOnce([[{ acquired: 0 }], []]);
		const run = vi.fn();
		await expect(repo.withLock(run)).rejects.toMatchObject({ code: "BUSY" });
		expect(run).not.toHaveBeenCalled();
		expect(connection.execute).toHaveBeenCalledOnce();
		expect(connection.release).toHaveBeenCalledOnce();
	});
	it("releases an acquired database lock when work fails", async () => {
		const { repo, connection } = fixture();
		connection.execute.mockResolvedValueOnce([[{ acquired: 1 }], []]);
		await expect(
			repo.withLock(async () => {
				throw new Error("failed");
			}),
		).rejects.toThrow("failed");
		expect(connection.execute).toHaveBeenLastCalledWith("SELECT RELEASE_LOCK('pi_saved_imports')");
		expect(connection.release).toHaveBeenCalledOnce();
	});
	it("rolls back the manifest if one item cannot be saved", async () => {
		const { repo, connection } = fixture();
		connection.execute.mockResolvedValueOnce([[], []]).mockRejectedValueOnce(new Error("item insert failed"));
		await expect(repo.create([note], 20)).rejects.toThrow("item insert failed");
		expect(connection.rollback).toHaveBeenCalledOnce();
		expect(connection.commit).not.toHaveBeenCalled();
		expect(connection.release).toHaveBeenCalledOnce();
	});
	it("reuses the canonical post identity even when its URL signature changes", async () => {
		const { repo, pool, save } = fixture();
		pool.execute.mockResolvedValueOnce([[{ material_id: "canonical" }], []]);
		expect(await repo.resolve({ ...note, url: note.url.replace("signed", "new-signature") })).toBe("canonical");
		expect(save).not.toHaveBeenCalled();
		expect(pool.execute).toHaveBeenCalledOnce();
	});
	it("recognizes existing manual links by exact platform post ID and rejects prefix collisions", async () => {
		const { repo, pool, save } = fixture();
		pool.execute.mockResolvedValueOnce([[], []]).mockResolvedValueOnce([
			[
				{ id: "evil", url: `https://other.test/explore/${note.id}` },
				{ id: "prefix", url: `https://www.xiaohongshu.com/explore/${note.id}a?xsec_token=signed` },
				{ id: "original", url: note.url.replace("signed", "old-signature") },
			],
			[],
		]);
		expect(await repo.resolve(note)).toBe("original");
		expect(save).not.toHaveBeenCalled();
		expect(pool.execute).toHaveBeenLastCalledWith(expect.stringContaining("INSERT INTO material_social_sources"), [
			note.id,
			"original",
		]);
	});
});
