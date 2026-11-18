import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentReachClient } from "../src/materials/agent-reach.ts";
import { LocalAssetStore } from "../src/materials/asset-store.ts";
import { type CollectionCommand, CollectionError, runCollectionCommand } from "../src/materials/collection-command.ts";
import { MaterialCollector } from "../src/materials/collector.ts";
import { MaterialService } from "../src/materials/service.ts";
import { socialTarget } from "../src/materials/social-source.ts";
import type { Material, MaterialAsset, MaterialRepository } from "../src/materials/types.ts";

const X_URL = "https://x.com/alice/status/123";
const NOTE_ID = "abcdef1234567890abcdef12";
const XHS_URL = `https://www.xiaohongshu.com/explore/${NOTE_ID}?xsec_token=keep-me`;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function folder(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "pi-collection-test-"));
	temporary.push(dir);
	return dir;
}

function response(items: unknown[], platform = "twitter", action = "thread") {
	return { code: 0, stdout: JSON.stringify({ schema_version: 1, ok: true, channel: platform, action, items }) };
}

function browserStatus() {
	return {
		code: 0,
		stdout: JSON.stringify({
			schema_version: 1,
			ok: true,
			result: { running: true, opencli_connected: true, opencli_context: "reach-owned-profile" },
		}),
	};
}

function repository(url = X_URL) {
	const material: Material = {
		id: "material",
		kind: "link",
		title: "Saved post",
		url,
		sourceType: "web",
		createdAt: 1,
		updatedAt: 1,
	};
	const assets: MaterialAsset[] = [];
	const repo: MaterialRepository = {
		search: vi.fn(),
		saveImageText: vi.fn(),
		getImageText: vi.fn(),
		findImageText: vi.fn(),
		get: vi.fn(async () => ({ material, assets })),
		save: vi.fn(async (input) => ({ ...material, id: "reply", url: input.url })),
		list: vi.fn(),
		findForDebt: vi.fn(),
		importDebt: vi.fn(),
		createAssetMaterial: vi.fn(),
		saveSnapshot: vi.fn(async (id, input) => ({
			id: `snapshot-${id}`,
			materialId: id,
			...input,
			contentHash: "hash",
			createdAt: 1,
		})),
		getSnapshot: vi.fn(),
		attachAsset: vi.fn(async (asset) => {
			assets.push(asset);
			return asset;
		}),
		beginCollection: vi.fn<MaterialRepository["beginCollection"]>(async (id, platform) => ({
			id: "attempt",
			materialId: id,
			platform,
			status: "running",
			createdAt: 1,
		})),
		finishCollection: vi.fn(async () => {}),
	};
	return { repo, material, assets };
}

describe("social source boundaries", () => {
	it("keeps signed note URLs and rejects unrelated hosts and non-post pages", () => {
		expect(socialTarget(XHS_URL).url).toBe(XHS_URL);
		expect(socialTarget("https://twitter.com/alice/status/123?s=20")).toMatchObject({
			platform: "twitter",
			postId: "123",
		});
		for (const value of [
			"https://x.com.evil.test/alice/status/123",
			"http://x.com/alice/status/123",
			"https://x.com/alice",
			"https://user:password@x.com/alice/status/123",
			"https://x.com:8443/alice/status/123",
		]) {
			expect(() => socialTarget(value)).toThrow();
		}
	});

	it("selects the requested tweet instead of treating the first reply as the original", async () => {
		const command = vi.fn<CollectionCommand>().mockResolvedValue(
			response([
				{ url: "https://x.com/bob/status/456", text: "Reply", raw: { id: "456" } },
				{ url: X_URL, text: "Original", author: "alice", raw: { id: "123" } },
			]),
		);
		const items = await new AgentReachClient(command).read(X_URL);
		expect(items.map((item) => item.text)).toEqual(["Original", "Reply"]);
		expect(command.mock.calls[0][1]).toEqual(["twitter", "thread", X_URL]);
	});

	it("rejects a thread that does not contain the requested tweet", async () => {
		const command = vi
			.fn<CollectionCommand>()
			.mockResolvedValue(response([{ url: "https://x.com/bob/status/456", text: "Not the target" }]));
		await expect(new AgentReachClient(command).read(X_URL)).rejects.toMatchObject({ code: "TARGET_NOT_RETURNED" });
	});

	it("rejects response schema and platform mismatches", async () => {
		for (const stdout of [
			JSON.stringify({ schema_version: 2, ok: true, items: [] }),
			response([], "web", "read").stdout,
			"not-json",
		]) {
			await expect(new AgentReachClient(async () => ({ code: 0, stdout })).read(X_URL)).rejects.toMatchObject({
				code: "INVALID_RESPONSE",
			});
		}
	});
});

describe("collection state and evidence", () => {
	it("uses a refreshed signed link only for the same post without changing its original material", async () => {
		const { repo, material } = repository();
		const refreshed = `${X_URL}?signed=refreshed`;
		const command = vi
			.fn<CollectionCommand>()
			.mockResolvedValue(response([{ url: refreshed, text: "Exact source" }]));
		const collector = new MaterialCollector(
			repo,
			new MaterialService(repo, new LocalAssetStore(await folder())),
			new AgentReachClient(command),
		);
		const result = await collector.collect(material.id, undefined, refreshed);
		expect(command.mock.calls[0][1]).toEqual(["twitter", "thread", refreshed]);
		expect(result.sources[0].url).toBe(refreshed);
		expect(material.url).toBe(X_URL);
		await expect(
			collector.collect(material.id, undefined, "https://x.com/bob/status/456?signed=other"),
		).rejects.toThrow("same social post");
		expect(command).toHaveBeenCalledOnce();
		expect(repo.beginCollection).toHaveBeenCalledOnce();
	});
	it.each([
		["NEED_LOGIN", "needs_login"],
		["PLATFORM_BLOCKED", "blocked"],
		["RATE_LIMITED", "rate_limited"],
		["NEED_SETUP", "needs_setup"],
		["TIMEOUT", "failed"],
	])("records %s without retrying or saving a false snapshot", async (code, status) => {
		const { repo } = repository();
		const command = vi.fn<CollectionCommand>().mockResolvedValue({
			code: 1,
			stdout: JSON.stringify({
				schema_version: 1,
				ok: false,
				error: { code, message: "Do not expose this untrusted error", hint: "secret" },
			}),
		});
		const files = new MaterialService(repo, new LocalAssetStore(await folder()));
		const result = await new MaterialCollector(repo, files, new AgentReachClient(command)).collect("material");
		expect(result).toMatchObject({ status, issues: [code], sources: [] });
		expect(command).toHaveBeenCalledOnce();
		expect(repo.saveSnapshot).not.toHaveBeenCalled();
		expect(repo.finishCollection).toHaveBeenCalledWith("attempt", expect.objectContaining({ status }));
		expect(JSON.stringify(result)).not.toContain("secret");
	});

	it("stores each tweet under its own source and does not claim a complete thread", async () => {
		const { repo } = repository();
		const command = vi.fn<CollectionCommand>().mockResolvedValue(
			response([
				{
					url: X_URL,
					text: "Original\nwith exact spacing",
					author: "alice",
					published_at: "2026-11-16",
					raw: { has_media: true },
				},
				{ url: "https://x.com/bob/status/456", text: "A reply", author: "bob" },
			]),
		);
		const files = new MaterialService(repo, new LocalAssetStore(await folder()));
		const result = await new MaterialCollector(repo, files, new AgentReachClient(command)).collect("material");
		expect(result.status).toBe("partial");
		expect(result.issues).toEqual(["THREAD_COMPLETENESS_UNKNOWN", "MEDIA_NOT_IMPORTED"]);
		expect(result.sources.map((item) => item.materialId)).toEqual(["material", "reply"]);
		expect(repo.saveSnapshot).toHaveBeenCalledWith(
			"material",
			expect.objectContaining({ content: "Original\nwith exact spacing" }),
		);
	});

	it("retains acquired body text if media collection requires another login", async () => {
		const { repo } = repository(XHS_URL);
		const command = vi
			.fn<CollectionCommand>()
			.mockResolvedValueOnce(response([{ url: XHS_URL, text: "Body" }], "xiaohongshu", "read"))
			.mockResolvedValueOnce({
				code: 1,
				stdout: JSON.stringify({ schema_version: 1, ok: false, error: { code: "NEED_LOGIN" } }),
			});
		const files = new MaterialService(repo, new LocalAssetStore(await folder()));
		const result = await new MaterialCollector(repo, files, new AgentReachClient(command)).collect("material");
		expect(result).toMatchObject({ status: "partial", issues: ["NEED_LOGIN"] });
		expect(result.sources).toHaveLength(1);
		expect(repo.saveSnapshot).toHaveBeenCalledOnce();
	});

	it("records cancellation before invoking a browser", async () => {
		const { repo } = repository();
		const command = vi.fn<CollectionCommand>();
		const controller = new AbortController();
		controller.abort();
		const files = new MaterialService(repo, new LocalAssetStore(await folder()));
		const result = await new MaterialCollector(repo, files, new AgentReachClient(command)).collect(
			"material",
			controller.signal,
		);
		expect(result.status).toBe("cancelled");
		expect(command).not.toHaveBeenCalled();
	});
});

describe("Xiaohongshu media", () => {
	it("uses the Reach profile, preserves order, detects actual image format, and removes staging files", async () => {
		const { repo, assets } = repository(XHS_URL);
		const store = new LocalAssetStore(await folder());
		let staging = "";
		const command = vi
			.fn<CollectionCommand>()
			.mockResolvedValueOnce(response([{ url: XHS_URL, text: "Text on a post" }], "xiaohongshu", "read"))
			.mockResolvedValueOnce(browserStatus())
			.mockImplementationOnce(async (_bin, args, _signal, env) => {
				expect(env?.OPENCLI_PROFILE).toBe("reach-owned-profile");
				expect(env?.OPENCLI_CDP_ENDPOINT).toBe("");
				staging = args[args.indexOf("--output") + 1];
				const dir = join(staging, NOTE_ID);
				await mkdir(dir);
				await writeFile(join(dir, `${NOTE_ID}_2.jpg`), PNG);
				await writeFile(join(dir, `${NOTE_ID}_1.jpg`), Buffer.from([255, 216, 255, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
				return {
					code: 0,
					stdout: JSON.stringify({
						ok: true,
						data: [
							{ index: 1, type: "image", status: "success" },
							{ index: 2, type: "image", status: "success" },
						],
					}),
				};
			});
		const result = await new MaterialCollector(
			repo,
			new MaterialService(repo, store),
			new AgentReachClient(command),
		).collect("material");
		expect(result).toMatchObject({ status: "partial", imageCount: 2, issues: ["IMAGES_NOT_ANALYZED"] });
		expect(assets.map((asset) => asset.contentType)).toEqual(["image/jpeg", "image/png"]);
		expect(result.images.map((image) => image.position)).toEqual([0, 1]);
		expect(await store.read(assets[1].sha256)).toEqual(PNG);
		await expect(stat(staging)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not fall back to a different browser if Reach has no connected profile", async () => {
		const command = vi.fn<CollectionCommand>().mockResolvedValue({
			code: 0,
			stdout: JSON.stringify({
				schema_version: 1,
				ok: true,
				result: { running: true, opencli_connected: false, opencli_context: "profile" },
			}),
		});
		await expect(new AgentReachClient(command).downloadImages(XHS_URL, await folder())).rejects.toMatchObject({
			code: "NEED_SETUP",
		});
		expect(command).toHaveBeenCalledOnce();
	});

	it("handles OpenCLI YAML authentication errors", async () => {
		const command = vi.fn<CollectionCommand>().mockResolvedValueOnce(browserStatus()).mockResolvedValueOnce({
			code: 1,
			stdout: "ok: false\nerror:\n  code: AUTH_REQUIRED\n  message: login required\n",
		});
		await expect(new AgentReachClient(command).downloadImages(XHS_URL, await folder())).rejects.toMatchObject({
			code: "NEED_LOGIN",
		});
	});

	it("does not count an HTML verification page saved as jpg as an image", async () => {
		const dir = await folder();
		await mkdir(join(dir, NOTE_ID));
		await writeFile(join(dir, NOTE_ID, `${NOTE_ID}_1.jpg`), "<html>log in</html>");
		const command = vi
			.fn<CollectionCommand>()
			.mockResolvedValueOnce(browserStatus())
			.mockResolvedValueOnce({ code: 0, stdout: JSON.stringify([{ index: 1, type: "image", status: "success" }]) });
		expect(await new AgentReachClient(command).downloadImages(XHS_URL, dir)).toEqual({
			images: [],
			issues: ["INVALID_IMAGE"],
		});
	});
});

describe("collection commands", () => {
	it("passes shell metacharacters as literal arguments", async () => {
		const dir = await folder();
		const script = join(dir, "arguments.mjs");
		await writeFile(script, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
		const value = "$(touch forbidden) ; echo secret";
		const result = await runCollectionCommand(process.execPath, [script, value]);
		expect(JSON.parse(result.stdout)).toEqual([value]);
		expect(await readFile(script, "utf8")).toContain("process.argv");
	});

	it("reports missing tools and pre-aborted work without exposing stderr", async () => {
		await expect(runCollectionCommand(join(await folder(), "not-installed"), [])).rejects.toMatchObject({
			code: "NEED_SETUP",
		});
		const controller = new AbortController();
		controller.abort();
		await expect(runCollectionCommand(process.execPath, [], controller.signal)).rejects.toBeInstanceOf(
			CollectionError,
		);
	});
});
