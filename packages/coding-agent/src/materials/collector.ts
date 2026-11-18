import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentReachClient } from "./agent-reach.ts";
import { CollectionError } from "./collection-command.ts";
import type { MaterialService } from "./service.ts";
import { socialTarget } from "./social-source.ts";
import type { CollectionResult, CollectionStatus, MaterialRepository } from "./types.ts";

const FAILURE_STATUS: Record<string, Exclude<CollectionStatus, "running">> = {
	NEED_LOGIN: "needs_login",
	NEED_SETUP: "needs_setup",
	PLATFORM_BLOCKED: "blocked",
	RATE_LIMITED: "rate_limited",
	CANCELLED: "cancelled",
};

export class MaterialCollector {
	private readonly repository: MaterialRepository;
	private readonly files: MaterialService;
	private readonly client: AgentReachClient;
	private readonly active = new Set<string>();

	constructor(repository: MaterialRepository, files: MaterialService, client = new AgentReachClient()) {
		this.repository = repository;
		this.files = files;
		this.client = client;
	}

	async collect(
		materialId: string,
		signal?: AbortSignal,
		sourceUrl?: string,
	): Promise<CollectionResult & { attemptId: string }> {
		if (this.active.has(materialId)) throw new Error("This material already has a collection in progress");
		this.active.add(materialId);
		try {
			return await this.run(materialId, signal, sourceUrl);
		} finally {
			this.active.delete(materialId);
		}
	}

	private async run(
		materialId: string,
		signal?: AbortSignal,
		sourceUrl?: string,
	): Promise<CollectionResult & { attemptId: string }> {
		const detail = await this.repository.get(materialId);
		if (!detail || detail.material.kind !== "link" || !detail.material.url)
			throw new Error("Collection requires an existing link material");
		const original = socialTarget(detail.material.url);
		const target = sourceUrl ? socialTarget(sourceUrl) : original;
		if (
			sourceUrl &&
			(!original.postId ||
				!target.postId ||
				original.platform !== target.platform ||
				original.postId.toLowerCase() !== target.postId.toLowerCase())
		)
			throw new Error("Refreshed link must identify the same social post");
		const attempt = await this.repository.beginCollection(materialId, target.platform);
		const result: CollectionResult = { status: "failed", sources: [], imageCount: 0, images: [], issues: [] };
		try {
			signal?.throwIfAborted();
			const items = await this.client.read(target.url, signal);
			for (const [index, item] of items.entries()) {
				signal?.throwIfAborted();
				if (!item.text?.trim()) {
					result.issues.push("TEXT_NOT_RETURNED");
					continue;
				}
				const material =
					index === 0
						? detail.material
						: await this.repository.save({
								kind: "link",
								url: item.url,
								title: (item.title || item.text).slice(0, 512),
								sourceType: target.platform,
							});
				const snapshot = await this.repository.saveSnapshot(material.id, {
					content: item.text,
					contentType: "text/plain",
					extractor: `agent-reach-v1:${target.platform}`,
				});
				result.sources.push({
					materialId: material.id,
					snapshotId: snapshot.id,
					url: item.url,
					author: item.author,
					publishedAt: item.publishedAt,
				});
			}
			if (target.platform === "twitter") {
				result.issues.push("THREAD_COMPLETENESS_UNKNOWN");
				if (items.some((item) => item.hasMedia)) result.issues.push("MEDIA_NOT_IMPORTED");
			} else {
				const temporary = await mkdtemp(join(tmpdir(), "pi-social-media-"));
				try {
					const media = await this.client.downloadImages(target.url, temporary, signal);
					result.issues.push(...media.issues);
					// A new capture gets its own immutable positions. The attempt records image count.
					const firstPosition = detail.assets
						.filter((asset) => asset.role === "image")
						.reduce((max, asset) => Math.max(max, asset.position + 1), 0);
					for (const image of media.images) {
						signal?.throwIfAborted();
						const saved = await this.files.saveFile({
							filePath: image.path,
							materialId,
							contentType: image.contentType,
							role: "image",
							position: firstPosition + image.position,
							sourceUrl: target.url,
							reuseExisting: true,
						});
						result.images.push({ assetId: saved.asset.id, position: image.position });
						result.imageCount++;
					}
				} finally {
					await rm(temporary, { recursive: true, force: true });
				}
			}
			if (!result.sources.length && !result.imageCount) result.issues.push("NO_CONTENT");
			result.status =
				result.sources.length || result.imageCount ? (result.issues.length ? "partial" : "success") : "failed";
		} catch (error) {
			const code = signal?.aborted ? "CANCELLED" : error instanceof CollectionError ? error.code : "STORAGE_ERROR";
			result.issues.push(code);
			result.status = result.sources.length || result.imageCount ? "partial" : (FAILURE_STATUS[code] ?? "failed");
		}
		result.issues = [...new Set(result.issues)];
		await this.repository.finishCollection(attempt.id, result);
		return { ...result, attemptId: attempt.id };
	}
}
