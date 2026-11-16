import { join, resolve } from "node:path";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { LocalAssetStore } from "../../materials/asset-store.ts";
import { MATERIAL_FILE_TYPES, MaterialService } from "../../materials/service.ts";
import type { MaterialRepository } from "../../materials/types.ts";
import { getMaterialRepository } from "../info-debt/db.ts";

export default function materialsExtension(
	pi: ExtensionAPI,
	repository: MaterialRepository = getMaterialRepository(),
): void {
	const assetStore = new LocalAssetStore(
		process.env.PI_MATERIAL_ASSET_DIR ?? join(getAgentDir(), "materials", "assets"),
	);
	const service = new MaterialService(repository, assetStore);

	pi.registerTool({
		name: "save_material",
		label: "Save Material",
		description:
			"Save an HTTP link or plain text as a source. This does not fetch a page or resolve debt. Duplicate sources reuse the existing material.",
		promptSnippet: "save_material: save a link or text source independently of debt",
		parameters: Type.Object({
			kind: Type.Union([Type.Literal("link"), Type.Literal("text")]),
			title: Type.String({ minLength: 1, maxLength: 512 }),
			url: Type.Optional(Type.String()),
			text: Type.Optional(Type.String()),
			sourceType: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
		}),
		async execute(_id, input) {
			const material = await repository.save(input);
			const { text: _text, ...metadata } = material;
			return { content: [{ type: "text", text: JSON.stringify(metadata) }], details: { materialId: material.id } };
		},
	});

	pi.registerTool({
		name: "list_materials",
		label: "List Materials",
		description:
			"List source metadata without body text. Use debtId to find sources captured with a debt. Use beforeId to request the next page.",
		parameters: Type.Object({
			debtId: Type.Optional(Type.String()),
			beforeId: Type.Optional(Type.String()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
		}),
		async execute(_id, input) {
			const materials = input.debtId
				? await repository.findForDebt(input.debtId)
				: await repository.list(input.limit ?? 20, input.beforeId);
			const metadata = materials.map(({ text: _text, ...item }) => item);
			return { content: [{ type: "text", text: JSON.stringify(metadata) }], details: { count: materials.length } };
		},
	});

	pi.registerTool({
		name: "get_material",
		label: "Get Material",
		description:
			"Read source metadata, ordered attachments, and a bounded snapshot excerpt. Pass snapshotId to read historical evidence. Offsets use JavaScript UTF-16 code units.",
		promptSnippet: "get_material: read saved source evidence by material and snapshot ID",
		parameters: Type.Object({
			materialId: Type.String(),
			snapshotId: Type.Optional(Type.String()),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			length: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
		}),
		async execute(_id, input) {
			const detail = await repository.get(input.materialId);
			if (!detail) throw new Error(`Material not found: ${input.materialId}`);
			const snapshot = await repository.getSnapshot(input.materialId, input.snapshotId);
			if (input.snapshotId && !snapshot) throw new Error(`Snapshot not found: ${input.snapshotId}`);
			const { text: _text, ...material } = detail.material;
			const offset = input.offset ?? 0;
			const result = {
				material,
				assets: detail.assets.map((asset) => ({ ...asset, filePath: assetStore.getPath(asset.sha256) })),
				snapshot: snapshot
					? {
							...snapshot,
							content: snapshot.content.slice(offset, offset + (input.length ?? 4000)),
							offset,
							totalLength: snapshot.content.length,
						}
					: undefined,
			};
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { materialId: material.id, snapshotId: snapshot?.id },
			};
		},
	});

	pi.registerTool({
		name: "save_material_snapshot",
		label: "Save Material Snapshot",
		description:
			"Save source text as immutable evidence. Supply an extractor name and version. Do not submit an AI summary as original evidence.",
		parameters: Type.Object({
			materialId: Type.String(),
			content: Type.String({ minLength: 1 }),
			contentType: Type.Union([
				Type.Literal("text/plain"),
				Type.Literal("text/markdown"),
				Type.Literal("text/html"),
			]),
			extractor: Type.String({ minLength: 1, maxLength: 191 }),
		}),
		async execute(_id, input) {
			const { content: _content, ...snapshot } = await repository.saveSnapshot(input.materialId, input);
			return { content: [{ type: "text", text: JSON.stringify(snapshot) }], details: { snapshotId: snapshot.id } };
		},
	});

	pi.registerTool({
		name: "save_material_file",
		label: "Save Material File",
		description:
			"Import a local image, PDF, or text file of at most 20 MiB. Attach it to materialId or create an asset material. Source files remain intact. This does not perform OCR.",
		parameters: Type.Object({
			filePath: Type.String(),
			contentType: Type.Union(MATERIAL_FILE_TYPES.map((value) => Type.Literal(value))),
			materialId: Type.Optional(Type.String()),
			title: Type.Optional(Type.String()),
			sourceType: Type.Optional(Type.String()),
			sourceUrl: Type.Optional(Type.String()),
			role: Type.Optional(
				Type.Union([
					Type.Literal("original"),
					Type.Literal("image"),
					Type.Literal("screenshot"),
					Type.Literal("archive"),
				]),
			),
			position: Type.Optional(Type.Integer({ minimum: 0, maximum: 1_000_000 })),
		}),
		async execute(_id, input, _signal, _onUpdate, ctx) {
			const result = await service.saveFile({ ...input, filePath: resolve(ctx.cwd, input.filePath) });
			return {
				content: [{ type: "text", text: JSON.stringify(result) }],
				details: { materialId: result.material.id, assetId: result.asset.id },
			};
		},
	});

	pi.registerTool({
		name: "import_debt_material",
		label: "Import Debt Material",
		description:
			"Import an existing debt's URL and captured text into material storage. Use the full debt ID. This leaves debt status unchanged.",
		parameters: Type.Object({ debtId: Type.String() }),
		async execute(_id, input) {
			await repository.importDebt(input.debtId);
			const materials = await repository.findForDebt(input.debtId);
			const metadata = materials.map(({ text: _text, ...material }) => material);
			return { content: [{ type: "text", text: JSON.stringify(metadata) }], details: { count: materials.length } };
		},
	});
}
