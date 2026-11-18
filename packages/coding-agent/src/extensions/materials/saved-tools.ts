import { Type } from "typebox";
import type { ExtensionAPI } from "../../core/extensions/types.ts";
import type { MaterialCollector } from "../../materials/collector.ts";
import { SavedMaterialImporter, savedImportSummary } from "../../materials/saved-importer.ts";
import type { SavedImportRepository } from "../../materials/saved-types.ts";
import type { MaterialRepository } from "../../materials/types.ts";

export function registerSavedImportTools(
	pi: ExtensionAPI,
	repository: SavedImportRepository,
	materials: MaterialRepository,
	collector: MaterialCollector,
): void {
	const importer = new SavedMaterialImporter(repository, materials, collector);
	pi.registerTool({
		name: "start_saved_import",
		label: "Start Saved Import",
		description:
			"Read up to 100 saved Xiaohongshu notes from the current logged-in Reach browser and persist a resumable import manifest. Default 20, in platform-returned order. Does not collect bodies yet. Returned count is not the library total. Specific folders and unbounded pagination are not supported.",
		promptSnippet: "start_saved_import: create a durable Xiaohongshu favorites import manifest",
		promptGuidelines: [
			"When asked to import Xiaohongshu favorites, start one bounded import, then call run_saved_import in batches until it completes or pauses. Use get_saved_import to resume an existing job instead of creating it again.",
			"Report the enumerated count and requested limit separately. Never claim the complete library was imported. Do not summarize every imported note or run OCR unless requested.",
		],
		executionMode: "sequential",
		parameters: Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }),
		async execute(_id, input, signal) {
			const job = await importer.start(input.limit ?? 20, signal);
			return {
				content: [{ type: "text", text: JSON.stringify(savedImportSummary(job)) }],
				details: { importId: job.id },
			};
		},
	});
	pi.registerTool({
		name: "run_saved_import",
		label: "Run Saved Import Batch",
		description:
			"Collect 1 to 5 pending notes from a durable import, sequentially with pacing. Reuses collected sources by platform note ID and persists progress after each note. Stops at login, verification, rate limits or infrastructure errors. A crashed running job can continue. This does not run OCR or change platform favorites.",
		promptGuidelines: [
			"Stop when an import is paused. Only set resume=true after the user has resolved its blocker or explicitly asked to retry. Do not loop on a paused job, switch accounts, or change backends.",
		],
		executionMode: "sequential",
		parameters: Type.Object({
			importId: Type.String(),
			batchSize: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
			resume: Type.Optional(Type.Boolean()),
		}),
		async execute(_id, input, signal, onUpdate) {
			const job = await importer.run(
				input.importId,
				input.batchSize ?? 3,
				input.resume ?? false,
				signal,
				(noteId, status) => {
					onUpdate?.({
						content: [{ type: "text", text: JSON.stringify({ noteId, status }) }],
						details: { importId: input.importId },
					});
				},
			);
			return {
				content: [{ type: "text", text: JSON.stringify(savedImportSummary(job)) }],
				details: { importId: job.id },
			};
		},
	});
	pi.registerTool({
		name: "get_saved_import",
		label: "Get Saved Import",
		description:
			"Read import progress from MySQL without contacting the platform. Omit importId for the latest job. Returns counts and at most 20 item summaries, not source bodies or signed URLs.",
		promptSnippet: "get_saved_import: last favorites import, imported note titles, and saved progress",
		promptGuidelines: [
			"When asked what was imported last time or to check a favorites import's progress, use get_saved_import. Do not query list_debts for imported favorites; imported sources are stored independently of business tasks.",
		],
		parameters: Type.Object({ importId: Type.Optional(Type.String()) }),
		async execute(_id, input) {
			const job = await repository.get(input.importId);
			return {
				content: [{ type: "text", text: JSON.stringify(job ? savedImportSummary(job) : { import: null }) }],
				details: { importId: job?.id },
			};
		},
	});
}
