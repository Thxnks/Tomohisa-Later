import { join, resolve } from "node:path";
import { Type } from "typebox";
import { getAgentDir } from "../../config.ts";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { LocalAssetStore } from "../../materials/asset-store.ts";
import { MaterialCollector } from "../../materials/collector.ts";
import { MaterialImageTextService } from "../../materials/image-text.ts";
import { MATERIAL_FILE_TYPES, MaterialService } from "../../materials/service.ts";
import { socialTarget } from "../../materials/social-source.ts";
import type { MaterialRepository } from "../../materials/types.ts";
import { retainDebtRepository } from "../info-debt/db.ts";
import { registerSavedImportTools } from "./saved-tools.ts";

export default function materialsExtension(pi: ExtensionAPI, providedRepository?: MaterialRepository): void {
	const shared = providedRepository ? undefined : retainDebtRepository();
	const repository = providedRepository ?? shared!.repository.materials;
	if (shared) pi.on("session_shutdown", () => shared.release());
	const assetStore = new LocalAssetStore(
		process.env.PI_MATERIAL_ASSET_DIR ?? join(getAgentDir(), "materials", "assets"),
	);
	const service = new MaterialService(repository, assetStore);
	const collector = new MaterialCollector(repository, service);
	const imageTextService = new MaterialImageTextService(repository, assetStore);
	if (shared) registerSavedImportTools(pi, shared.repository.savedImports, repository, collector);

	pi.registerTool({
		name: "search_materials",
		label: "Search Materials",
		description:
			"Search saved titles, original body snapshots, and derived image text using literal keywords. Space-separated terms must all match. Returns bounded excerpts with evidence IDs and UTF-16 offsets. Defaults to current evidence. Metadata-only hits contain no source text.",
		promptSnippet: "search_materials: find saved source evidence by keywords, including Chinese and technical names",
		promptGuidelines: [
			"For questions about saved source content, use search_materials, then get_material with the returned snapshotId or imageTextId. Cite the original URL and evidence ID.",
			"Image text is a machine transcription and can contain errors. Cite its assetId and imageTextId; inspect the source image when wording matters. Do not present metadata-only matches as evidence.",
			"Try short keywords rather than an entire question. Report an empty result instead of inventing saved knowledge.",
		],
		parameters: Type.Object({
			query: Type.String({ minLength: 1, maxLength: 256 }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
			excerptLength: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
			sourceType: Type.Optional(Type.String({ minLength: 1, maxLength: 64 })),
			project: Type.Optional(Type.String({ minLength: 1, maxLength: 191 })),
			materialId: Type.Optional(Type.String()),
			includeHistory: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, input) {
			const hits = await repository.search(input);
			return {
				content: [{ type: "text", text: JSON.stringify({ hits, includeHistory: input.includeHistory ?? false }) }],
				details: { count: hits.length },
			};
		},
	});

	pi.registerTool({
		name: "extract_material_image_text",
		label: "Extract Image Text",
		description:
			"Transcribe one saved image locally with macOS Vision (Chinese and English). Requires Xcode Command Line Tools. Saves derived text linked to the original asset, without replacing source snapshots. Reuses existing output for the same image and extractor version. This does not interpret charts or describe pictures.",
		promptSnippet: "extract_material_image_text: make text in a saved image searchable without sending it to a model",
		promptGuidelines: [
			"When relevant saved images have no image text, extract the required images individually. Use the collection's image manifest to select current images. Do not automatically process the entire library.",
		],
		executionMode: "sequential",
		parameters: Type.Object({ materialId: Type.String(), assetId: Type.String() }),
		async execute(_id, input, signal) {
			const { imageText, reused } = await imageTextService.extract(input.materialId, input.assetId, signal);
			const { content, ...metadata } = imageText;
			return {
				content: [
					{
						type: "text",
						text: JSON.stringify({
							imageText: metadata,
							reused,
							characterCount: content.length,
							noTextDetected: !content.trim(),
							derived: true,
						}),
					},
				],
				details: { imageTextId: imageText.id, assetId: imageText.assetId },
			};
		},
	});

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
			"List recently saved source metadata, newest first, including imported favorites without Information Debt. This is the saved-source library. Use debtId to find sources captured with a debt, or beforeId for the next page. Does not return body text or a library-wide total.",
		promptSnippet: "list_materials: recently saved sources, including bulk-imported favorites, newest first",
		promptGuidelines: [
			"For questions about recent saved sources, such as 上次收藏了啥 or 最近保存了什么, use list_materials. Imported favorites do not need Information Debt records and are absent from list_debts.",
			"Use get_saved_import for the last favorites import or its progress. Use search_materials for a topic within source content. Use list_debts only for business tasks, priorities, or next actions.",
		],
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
			"Read source metadata, ordered attachments, and bounded evidence text. Pass snapshotId for an original body snapshot, or imageTextId for a derived image transcription. Offsets use JavaScript UTF-16 code units.",
		promptSnippet: "get_material: read saved source evidence by material and snapshot ID",
		parameters: Type.Object({
			materialId: Type.String(),
			snapshotId: Type.Optional(Type.String()),
			imageTextId: Type.Optional(Type.String()),
			offset: Type.Optional(Type.Integer({ minimum: 0 })),
			length: Type.Optional(Type.Integer({ minimum: 1, maximum: 12000 })),
		}),
		async execute(_id, input) {
			if (input.snapshotId && input.imageTextId) throw new Error("Provide at most one of snapshotId or imageTextId");
			const detail = await repository.get(input.materialId);
			if (!detail) throw new Error(`Material not found: ${input.materialId}`);
			const snapshot = input.imageTextId
				? undefined
				: await repository.getSnapshot(input.materialId, input.snapshotId);
			if (input.snapshotId && !snapshot) throw new Error(`Snapshot not found: ${input.snapshotId}`);
			const imageText = input.imageTextId
				? await repository.getImageText(input.materialId, input.imageTextId)
				: undefined;
			if (input.imageTextId && !imageText) throw new Error(`Image text not found: ${input.imageTextId}`);
			const { text: _text, ...material } = detail.material;
			const offset = input.offset ?? 0;
			const result = {
				material,
				collection: detail.collection,
				imageTexts: detail.imageTexts ?? [],
				imageText: imageText
					? {
							...imageText,
							content: imageText.content.slice(offset, offset + (input.length ?? 4000)),
							offset,
							totalLength: imageText.content.length,
							derived: true,
						}
					: undefined,
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
				details: { materialId: material.id, snapshotId: snapshot?.id, imageTextId: imageText?.id },
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
		name: "collect_material",
		label: "Collect Social Material",
		description:
			"Collect an X or Xiaohongshu post using Agent-Reach. Provide either a saved material ID or a URL. Login remains in the external browser. This tool does not log in or run OCR. Partial results retain source evidence.",
		promptSnippet: "collect_material: collect saved X or Xiaohongshu sources and report missing content",
		promptGuidelines: [
			"When asked to collect an X or Xiaohongshu link, use collect_material. After capturing social debt, find its material with list_materials and collect it.",
			"Report collection issues. Stop when login, platform verification, or rate limits require user action. Do not retry automatically.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			materialId: Type.Optional(Type.String()),
			url: Type.Optional(Type.String()),
			title: Type.Optional(Type.String({ minLength: 1, maxLength: 512 })),
		}),
		async execute(_id, input, signal) {
			if (Boolean(input.materialId) === Boolean(input.url))
				throw new Error("Provide exactly one of materialId or url");
			let materialId = input.materialId;
			if (input.url) {
				const target = socialTarget(input.url);
				materialId = (
					await repository.save({
						kind: "link",
						title: input.title ?? target.url.slice(0, 512),
						url: target.url,
						sourceType: target.platform,
					})
				).id;
			}
			const result = await collector.collect(materialId!, signal);
			return {
				content: [{ type: "text", text: JSON.stringify({ materialId, ...result }) }],
				details: { materialId, status: result.status },
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
