import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type CollectionCommand, type CollectionCommandResult, CollectionError } from "./collection-command.ts";
import { record } from "./social-source.ts";

export function errorCode(value: unknown): string {
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
	if (code === "EMPTY_RESULT") return "EMPTY_LIST_UNVERIFIED";
	return "UPSTREAM_BROKEN";
}

export function parseJson(output: string): unknown {
	try {
		return JSON.parse(output);
	} catch {
		throw new CollectionError("INVALID_RESPONSE");
	}
}

export function opencliRows(result: CollectionCommandResult): unknown[] {
	let parsed: unknown;
	try {
		parsed = parseJson(result.stdout);
	} catch {
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
	if (result.code !== 0 || !Array.isArray(rows) || rows.length > 100) throw new CollectionError("INVALID_RESPONSE");
	return rows;
}

/** Only the prepared Reach browser can be started. Never select another profile. */
export async function boundOpenCLI(
	command: CollectionCommand,
	signal?: AbortSignal,
	startPreparedBrowser = false,
): Promise<{ binary: string; env: Record<string, string> }> {
	const binary = process.env.PI_AGENT_REACH_BIN ?? "agent-reach";
	let response = await command(binary, ["browser", "status"], signal);
	let data = record(parseJson(response.stdout));
	if (data?.ok === false) throw new CollectionError(errorCode(data.error));
	let browser = record(data?.result);
	if (
		response.code === 0 &&
		data?.schema_version === 1 &&
		data.ok === true &&
		browser?.running === false &&
		startPreparedBrowser &&
		typeof browser.chrome === "string" &&
		typeof browser.extension_version === "string" &&
		typeof browser.opencli_context === "string"
	) {
		response = await command(binary, ["browser", "setup"], signal);
		data = record(parseJson(response.stdout));
		if (data?.ok === false) throw new CollectionError(errorCode(data.error));
		browser = record(data?.result);
	}
	if (
		response.code !== 0 ||
		data?.schema_version !== 1 ||
		data.ok !== true ||
		browser?.running !== true ||
		browser.opencli_connected !== true ||
		typeof browser.opencli_context !== "string" ||
		!browser.opencli_context
	)
		throw new CollectionError("NEED_SETUP");
	const privateBinary = join(homedir(), ".agent-reach", "tools", "npm-global", "bin", "opencli");
	return {
		binary: process.env.PI_OPENCLI_BIN ?? (existsSync(privateBinary) ? privateBinary : "opencli"),
		env: {
			OPENCLI_PROFILE: browser.opencli_context,
			OPENCLI_WINDOW: "background",
			OPENCLI_CDP_ENDPOINT: "",
			OPENCLI_CDP_TARGET: "",
		},
	};
}
