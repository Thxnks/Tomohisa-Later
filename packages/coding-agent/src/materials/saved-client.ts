import { type CollectionCommand, CollectionError, runCollectionCommand } from "./collection-command.ts";
import { boundOpenCLI, opencliRows } from "./opencli.ts";
import type { SavedNote } from "./saved-types.ts";
import { record, socialTarget } from "./social-source.ts";

export function validateSavedNote(note: SavedNote): void {
	if (!/^[a-f0-9]{24}$/.test(note.id)) throw new CollectionError("INVALID_SAVED_NOTE");
	let target: ReturnType<typeof socialTarget>;
	try {
		target = socialTarget(note.url);
	} catch {
		throw new CollectionError("INVALID_SAVED_NOTE");
	}
	if (
		target.platform !== "xiaohongshu" ||
		target.postId?.toLowerCase() !== note.id ||
		!new URL(note.url).searchParams.get("xsec_token") ||
		note.url.length > 8192 ||
		!note.title.trim() ||
		note.title.length > 512 ||
		(note.author?.length ?? 0) > 256
	)
		throw new CollectionError("INVALID_SAVED_NOTE");
}

export class XiaohongshuSavedClient {
	private readonly command: CollectionCommand;
	constructor(command: CollectionCommand = runCollectionCommand) {
		this.command = command;
	}

	async list(limit: number, signal?: AbortSignal): Promise<SavedNote[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new Error("Saved limit must be between 1 and 100");
		const { binary, env } = await boundOpenCLI(this.command, signal, true);
		const response = await this.command(
			binary,
			["xiaohongshu", "saved", "--limit", String(limit), "-f", "json"],
			signal,
			env,
		);
		const rows = opencliRows(response);
		if (!rows.length) throw new CollectionError("EMPTY_LIST_UNVERIFIED");
		const notes = new Map<string, SavedNote>();
		for (const value of rows) {
			const row = record(value);
			if (!row || typeof row.id !== "string" || typeof row.url !== "string")
				throw new CollectionError("INVALID_SAVED_NOTE");
			const note: SavedNote = {
				id: row.id.toLowerCase(),
				url: row.url,
				title:
					typeof row.title === "string" && row.title.trim() ? row.title.slice(0, 512) : `Xiaohongshu ${row.id}`,
				author: typeof row.author === "string" ? row.author.slice(0, 256) : undefined,
			};
			validateSavedNote(note);
			if (!notes.has(note.id)) notes.set(note.id, note);
		}
		return [...notes.values()].slice(0, limit);
	}
}
