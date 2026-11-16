import type { MaterialSearchInput } from "./types.ts";

export function searchOptions(input: MaterialSearchInput): { terms: string[]; limit: number; excerptLength: number } {
	const query = input.query.trim();
	const terms = [...new Set(query.split(/\s+/u))];
	if (!query || query.length > 256 || terms.length > 8)
		throw new Error("query must contain 1 to 256 characters and at most 8 terms");
	const limit = input.limit ?? 10;
	const excerptLength = input.excerptLength ?? 400;
	if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error("limit must be between 1 and 20");
	if (!Number.isInteger(excerptLength) || excerptLength < 1 || excerptLength > 1000)
		throw new Error("excerptLength must be between 1 and 1000");
	if (input.sourceType !== undefined && (!input.sourceType.trim() || input.sourceType.length > 64))
		throw new Error("Invalid sourceType");
	if (input.project !== undefined && (!input.project.trim() || input.project.length > 191))
		throw new Error("Invalid project");
	return { terms, limit, excerptLength };
}

/** Offsets always address the stored string, including its original case and whitespace. */
export function searchExcerpt(
	content: string,
	terms: string[],
	length: number,
): { excerpt: string; offset: number; totalLength: number } {
	const matches = terms
		.map((term) => new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "iu").exec(content)?.index)
		.filter((index): index is number => index !== undefined);
	const match = matches.length ? Math.min(...matches) : 0;
	let offset = Math.max(0, match - Math.min(80, Math.floor(length / 4)));
	if (offset > 0 && /[\uDC00-\uDFFF]/u.test(content[offset])) offset--;
	let end = Math.min(content.length, offset + length);
	if (end < content.length && /[\uDC00-\uDFFF]/u.test(content[end])) end--;
	return { excerpt: content.slice(offset, end), offset, totalLength: content.length };
}
