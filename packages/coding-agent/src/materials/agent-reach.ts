import { existsSync } from "node:fs";
import { open, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { type CollectionCommand, CollectionError, runCollectionCommand } from "./collection-command.ts";
import { record, socialTarget } from "./social-source.ts";

export interface SocialItem {
	url: string;
	text?: string;
	title?: string;
	author?: string;
	publishedAt?: string;
	hasMedia: boolean;
}

export interface DownloadedImage {
	path: string;
	position: number;
	contentType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
}

export interface SocialMediaResult {
	images: DownloadedImage[];
	issues: string[];
}

function errorCode(value: unknown): string {
	const code = record(value)?.code;
	if (
		[
			"NEED_SETUP",
			"NEED_LOGIN",
			"RATE_LIMITED",
			"PLATFORM_BLOCKED",
			"NOT_FOUND",
			"BAD_INPUT",
			"BUSY",
			"TIMEOUT",
		].includes(String(code))
	)
		return String(code);
	if (code === "AUTH_REQUIRED" || code === "LOGIN_REQUIRED") return "NEED_LOGIN";
	if (code === "SECURITY_BLOCK" || code === "CAPTCHA_REQUIRED") return "PLATFORM_BLOCKED";
	return "UPSTREAM_BROKEN";
}

function parseJson(output: string): unknown {
	try {
		return JSON.parse(output);
	} catch {
		throw new CollectionError("INVALID_RESPONSE");
	}
}

export class AgentReachClient {
	private readonly command: CollectionCommand;
	constructor(command: CollectionCommand = runCollectionCommand) {
		this.command = command;
	}

	async read(url: string, signal?: AbortSignal): Promise<SocialItem[]> {
		const target = socialTarget(url);
		const action = target.platform === "twitter" ? "thread" : "read";
		const response = await this.command(
			process.env.PI_AGENT_REACH_BIN ?? "agent-reach",
			[target.platform, action, target.url],
			signal,
		);
		const data = record(parseJson(response.stdout));
		if (!data || data.schema_version !== 1) throw new CollectionError("INVALID_RESPONSE");
		if (data.ok === false) throw new CollectionError(errorCode(data.error));
		if (
			response.code !== 0 ||
			data.ok !== true ||
			data.channel !== target.platform ||
			data.action !== action ||
			!Array.isArray(data.items) ||
			data.items.length > 100
		) {
			throw new CollectionError("INVALID_RESPONSE");
		}
		const items: SocialItem[] = [];
		for (const value of data.items) {
			const item = record(value);
			if (!item) throw new CollectionError("INVALID_RESPONSE");
			const raw = record(item.raw);
			let itemUrl = typeof item.url === "string" ? item.url : undefined;
			if (!itemUrl && target.platform === "twitter" && raw?.id === target.postId) itemUrl = target.url;
			if (!itemUrl && target.platform === "xiaohongshu" && data.items.length === 1) itemUrl = target.url;
			if (!itemUrl) continue;
			let parsed: ReturnType<typeof socialTarget>;
			try {
				parsed = socialTarget(itemUrl);
			} catch {
				throw new CollectionError("SOURCE_MISMATCH");
			}
			if (parsed.platform !== target.platform) throw new CollectionError("SOURCE_MISMATCH");
			items.push({
				url: itemUrl,
				text: typeof item.text === "string" ? item.text : undefined,
				title: typeof item.title === "string" ? item.title : undefined,
				author: typeof item.author === "string" ? item.author : undefined,
				publishedAt: typeof item.published_at === "string" ? item.published_at : undefined,
				hasMedia:
					raw?.has_media === true ||
					(typeof raw?.media_urls === "string" && raw.media_urls.length > 0) ||
					(Array.isArray(raw?.media_urls) && raw.media_urls.length > 0),
			});
		}
		if (target.platform === "twitter") {
			const index = items.findIndex((item) => socialTarget(item.url).postId === target.postId);
			if (index === -1) throw new CollectionError("TARGET_NOT_RETURNED");
			return [items[index], ...items.filter((_item, i) => i !== index)];
		}
		if (items.length !== 1 || (target.postId && socialTarget(items[0].url).postId !== target.postId)) {
			throw new CollectionError("TARGET_NOT_RETURNED");
		}
		return items;
	}

	async downloadImages(url: string, output: string, signal?: AbortSignal): Promise<SocialMediaResult> {
		const target = socialTarget(url);
		if (target.platform !== "xiaohongshu") throw new CollectionError("BAD_INPUT");
		// Ask Reach for the exact bound profile. Never let OpenCLI choose another browser.
		const status = await this.command(process.env.PI_AGENT_REACH_BIN ?? "agent-reach", ["browser", "status"], signal);
		const statusData = record(parseJson(status.stdout));
		if (statusData?.ok === false) throw new CollectionError(errorCode(statusData.error));
		const browser = record(statusData?.result);
		if (
			status.code !== 0 ||
			statusData?.schema_version !== 1 ||
			statusData.ok !== true ||
			browser?.running !== true ||
			browser.opencli_connected !== true ||
			typeof browser.opencli_context !== "string" ||
			!browser.opencli_context
		) {
			throw new CollectionError("NEED_SETUP");
		}
		const privateBinary = join(homedir(), ".agent-reach", "tools", "npm-global", "bin", "opencli");
		const binary = process.env.PI_OPENCLI_BIN ?? (existsSync(privateBinary) ? privateBinary : "opencli");
		const result = await this.command(
			binary,
			["xiaohongshu", "download", url, "--output", output, "-f", "json"],
			signal,
			{
				OPENCLI_PROFILE: browser.opencli_context,
				OPENCLI_WINDOW: "background",
				OPENCLI_CDP_ENDPOINT: "",
				OPENCLI_CDP_TARGET: "",
			},
		);
		let parsed: unknown;
		try {
			parsed = parseJson(result.stdout);
		} catch {
			// OpenCLI can emit a YAML error envelope even with JSON output selected.
			const start = result.stdout.search(/^ok: false\s*$/m);
			if (start === -1) throw new CollectionError("INVALID_RESPONSE");
			try {
				parsed = parseYaml(result.stdout.slice(start), { maxAliasCount: 0 });
			} catch {
				throw new CollectionError("INVALID_RESPONSE");
			}
			if (record(parsed)?.ok !== false) throw new CollectionError("INVALID_RESPONSE");
		}
		const envelope = record(parsed);
		if (envelope?.ok === false) throw new CollectionError(errorCode(envelope.error));
		const rows = Array.isArray(parsed) ? parsed : envelope?.ok === true ? envelope.data : undefined;
		if (result.code !== 0 || !Array.isArray(rows) || rows.length === 0 || rows.length > 100)
			throw new CollectionError("INVALID_RESPONSE");
		const files = new Map<number, string>();
		const root = await realpath(output);
		for (const directory of await readdir(output, { withFileTypes: true })) {
			if (!directory.isDirectory() || !/^[a-f0-9]+$/i.test(directory.name)) continue;
			if (target.postId && directory.name !== target.postId) throw new CollectionError("SOURCE_MISMATCH");
			for (const file of await readdir(join(output, directory.name), { withFileTypes: true })) {
				const match = new RegExp(`^${directory.name}_(\\d+)\\.jpg$`).exec(file.name);
				if (!match || !file.isFile()) continue;
				const path = await realpath(join(output, directory.name, file.name));
				if (relative(root, path).startsWith("..") || resolve(root) === path)
					throw new CollectionError("INVALID_MEDIA");
				const index = Number(match[1]);
				if (files.has(index)) throw new CollectionError("INVALID_MEDIA");
				files.set(index, path);
			}
		}
		const images: DownloadedImage[] = [];
		const issues: string[] = [];
		const indices = new Set<number>();
		let imagePosition = 0;
		for (const value of rows) {
			const row = record(value);
			if (!row || !Number.isInteger(row.index) || Number(row.index) < 1 || indices.has(Number(row.index)))
				throw new CollectionError("INVALID_RESPONSE");
			indices.add(Number(row.index));
			if (row.type !== "image") {
				issues.push("VIDEO_NOT_IMPORTED");
				continue;
			}
			const position = imagePosition++;
			const path = files.get(Number(row.index));
			if (row.status !== "success" || !path) {
				issues.push("IMAGE_DOWNLOAD_FAILED");
				continue;
			}
			const file = await open(path, "r");
			const header = Buffer.alloc(12);
			try {
				await file.read(header, 0, header.length, 0);
			} finally {
				await file.close();
			}
			const contentType = header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
				? "image/png"
				: header[0] === 255 && header[1] === 216 && header[2] === 255
					? "image/jpeg"
					: header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP"
						? "image/webp"
						: /^GIF8[79]a/.test(header.toString("ascii", 0, 6))
							? "image/gif"
							: undefined;
			if (!contentType) {
				issues.push("INVALID_IMAGE");
				continue;
			}
			images.push({ path, position, contentType });
		}
		if (images.length) issues.push("IMAGES_NOT_ANALYZED");
		return { images, issues: [...new Set(issues)] };
	}
}
