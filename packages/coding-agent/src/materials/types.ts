/** Saved sources are independent of debt status and agent sessions. */
export type MaterialKind = "link" | "text" | "asset";
export type ContentType = "text/plain" | "text/markdown" | "text/html";
export type AssetRole = "original" | "image" | "screenshot" | "archive";

export interface Material {
	id: string;
	kind: MaterialKind;
	title: string;
	sourceType: string;
	createdAt: number;
	updatedAt: number;
	url?: string;
	text?: string;
	latestSnapshotId?: string;
}

export interface MaterialSnapshot {
	id: string;
	materialId: string;
	content: string;
	contentType: ContentType;
	contentHash: string;
	extractor: string;
	createdAt: number;
}

export interface MaterialAsset {
	id: string;
	materialId: string;
	sha256: string;
	size: number;
	contentType: string;
	fileName: string;
	role: AssetRole;
	position: number;
	sourceUrl?: string;
	createdAt: number;
}

export interface MaterialDetail {
	material: Material;
	assets: MaterialAsset[];
	collection?: CollectionAttempt;
	imageTexts?: Omit<MaterialImageText, "content">[];
}

/** Machine transcription is derived data, never an original source snapshot. */
export interface MaterialImageText {
	id: string;
	materialId: string;
	assetId: string;
	content: string;
	contentHash: string;
	extractor: string;
	createdAt: number;
}

export interface MaterialSearchInput {
	query: string;
	limit?: number;
	excerptLength?: number;
	sourceType?: string;
	project?: string;
	materialId?: string;
	includeHistory?: boolean;
}

export interface MaterialSearchHit {
	materialId: string;
	title: string;
	url?: string;
	sourceType: string;
	kind: "snapshot" | "image_text" | "metadata";
	snapshotId?: string;
	imageTextId?: string;
	assetId?: string;
	extractor?: string;
	createdAt: number;
	excerpt: string;
	offset: number;
	totalLength: number;
}

export type SocialPlatform = "twitter" | "xiaohongshu";
export type CollectionStatus =
	| "running"
	| "success"
	| "partial"
	| "needs_login"
	| "needs_setup"
	| "blocked"
	| "rate_limited"
	| "failed"
	| "cancelled";

export interface CollectedSource {
	materialId: string;
	snapshotId: string;
	url: string;
	author?: string;
	publishedAt?: string;
}

export interface CollectionResult {
	status: Exclude<CollectionStatus, "running">;
	sources: CollectedSource[];
	imageCount: number;
	images: { assetId: string; position: number }[];
	issues: string[];
}

export interface CollectionAttempt {
	id: string;
	materialId: string;
	platform: SocialPlatform;
	status: CollectionStatus;
	createdAt: number;
	finishedAt?: number;
	result?: CollectionResult;
}

export interface SaveMaterialInput {
	kind: "link" | "text";
	title: string;
	sourceType?: string;
	url?: string;
	text?: string;
}

export interface SaveSnapshotInput {
	content: string;
	contentType: ContentType;
	extractor: string;
}

export interface MaterialRepository {
	search(input: MaterialSearchInput): Promise<MaterialSearchHit[]>;
	saveImageText(materialId: string, assetId: string, content: string, extractor: string): Promise<MaterialImageText>;
	getImageText(materialId: string, imageTextId: string): Promise<MaterialImageText | undefined>;
	findImageText(materialId: string, assetId: string, extractor: string): Promise<MaterialImageText | undefined>;
	beginCollection(materialId: string, platform: SocialPlatform): Promise<CollectionAttempt>;
	finishCollection(id: string, result: CollectionResult): Promise<void>;
	save(input: SaveMaterialInput): Promise<Material>;
	get(id: string): Promise<MaterialDetail | undefined>;
	list(limit: number, beforeId?: string): Promise<Material[]>;
	findForDebt(debtId: string): Promise<Material[]>;
	importDebt(debtId: string): Promise<void>;
	saveSnapshot(materialId: string, input: SaveSnapshotInput): Promise<MaterialSnapshot>;
	getSnapshot(materialId: string, snapshotId?: string): Promise<MaterialSnapshot | undefined>;
	createAssetMaterial(
		title: string,
		sourceType: string,
		asset: MaterialAsset,
	): Promise<{ material: Material; asset: MaterialAsset }>;
	attachAsset(asset: MaterialAsset): Promise<MaterialAsset>;
}
