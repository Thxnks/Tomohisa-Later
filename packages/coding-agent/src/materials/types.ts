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
