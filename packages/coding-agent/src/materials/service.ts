import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { LocalAssetStore } from "./asset-store.ts";
import type { AssetRole, Material, MaterialAsset, MaterialRepository } from "./types.ts";

export const MAX_MATERIAL_FILE_BYTES = 20 * 1024 * 1024;
export const MATERIAL_FILE_TYPES = [
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
	"application/pdf",
	"text/plain",
	"text/markdown",
	"text/html",
] as const;

export interface SaveMaterialFileInput {
	filePath: string;
	contentType: (typeof MATERIAL_FILE_TYPES)[number];
	materialId?: string;
	title?: string;
	sourceType?: string;
	sourceUrl?: string;
	role?: AssetRole;
	position?: number;
	reuseExisting?: boolean;
}

export class MaterialService {
	private readonly repository: MaterialRepository;
	private readonly assets: LocalAssetStore;

	constructor(repository: MaterialRepository, assets: LocalAssetStore) {
		this.repository = repository;
		this.assets = assets;
	}

	async saveFile(input: SaveMaterialFileInput): Promise<{ material: Material; asset: MaterialAsset }> {
		if (!MATERIAL_FILE_TYPES.includes(input.contentType)) throw new Error("Unsupported material file type");
		const position = input.position ?? 0;
		if (!Number.isInteger(position) || position < 0 || position > 1_000_000)
			throw new Error("Invalid asset position");
		const role = input.role ?? "original";
		if (!["original", "image", "screenshot", "archive"].includes(role)) throw new Error("Invalid asset role");
		const fileName = basename(input.filePath);
		const title = input.title?.trim() ?? fileName;
		const sourceType = input.sourceType ?? "manual";
		if (!title || title.length > 512 || !fileName || fileName.length > 512)
			throw new Error("Invalid title or file name");
		if (!sourceType.trim() || sourceType.length > 64) throw new Error("Invalid sourceType");
		if (input.sourceUrl) {
			const url = new URL(input.sourceUrl);
			if (
				!["http:", "https:"].includes(url.protocol) ||
				url.username ||
				url.password ||
				input.sourceUrl.length > 8192
			) {
				throw new Error("sourceUrl must be an HTTP or HTTPS URL without credentials");
			}
		}
		const existing = input.materialId ? await this.repository.get(input.materialId) : undefined;
		if (input.materialId && !existing) throw new Error(`Material not found: ${input.materialId}`);
		const file = await open(input.filePath, constants.O_RDONLY | constants.O_NONBLOCK);
		let data: Buffer;
		try {
			const stat = await file.stat();
			if (!stat.isFile() || stat.size === 0 || stat.size > MAX_MATERIAL_FILE_BYTES) {
				throw new Error("Material file must be a non-empty regular file of at most 20 MiB");
			}
			// A bounded read also protects against files that grow after stat().
			const buffer = Buffer.alloc(stat.size + 1);
			let offset = 0;
			while (offset < buffer.length) {
				const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
				if (!bytesRead) break;
				offset += bytesRead;
			}
			if (offset !== stat.size) throw new Error("Material file changed during import");
			data = buffer.subarray(0, offset);
		} finally {
			await file.close();
		}
		const blob = await this.assets.put(data);
		if (existing && input.reuseExisting) {
			const saved = existing.assets.find(
				(asset) => asset.role === role && asset.sha256 === blob.sha256 && asset.contentType === input.contentType,
			);
			if (saved) return { material: existing.material, asset: saved };
		}
		const asset: MaterialAsset = {
			id: randomUUID(),
			materialId: existing?.material.id ?? randomUUID(),
			...blob,
			fileName,
			contentType: input.contentType,
			role,
			position,
			sourceUrl: input.sourceUrl,
			createdAt: Date.now(),
		};
		if (existing) {
			return { material: existing.material, asset: await this.repository.attachAsset(asset) };
		}
		return this.repository.createAssetMaterial(title, sourceType, asset);
	}
}
