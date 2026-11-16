import type { SocialPlatform } from "./types.ts";

export function socialTarget(value: string): { platform: SocialPlatform; url: string; postId?: string } {
	const url = new URL(value);
	if (url.protocol !== "https:" || url.username || url.password || url.port)
		throw new Error("Use an HTTPS social post URL without credentials");
	if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(url.hostname)) {
		const match = /^\/(?:[A-Za-z0-9_]+|i\/web)\/status\/(\d+)\/?$/.exec(url.pathname);
		if (!match) throw new Error("Use a direct X status URL");
		return { platform: "twitter", url: url.toString(), postId: match[1] };
	}
	if (["xiaohongshu.com", "www.xiaohongshu.com"].includes(url.hostname)) {
		const match =
			/^\/(?:explore|search_result)\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname) ??
			/^\/user\/profile\/[A-Za-z0-9_-]+\/([A-Za-z0-9_-]+)\/?$/.exec(url.pathname);
		if (!match) throw new Error("Use a direct Xiaohongshu note URL");
		return { platform: "xiaohongshu", url: url.toString(), postId: match[1] };
	}
	if (url.hostname === "xhslink.com" && /^\/[A-Za-z0-9_/-]+$/.test(url.pathname)) {
		return { platform: "xiaohongshu", url: url.toString() };
	}
	throw new Error("Only X and Xiaohongshu post URLs are supported");
}

export function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
