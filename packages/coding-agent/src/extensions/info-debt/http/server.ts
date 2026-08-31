import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DebtRepository } from "../db.ts";
import { DebtService } from "../service.ts";

const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_INFO_DEBT_HTTP_PORT = 43_127;
const MAX_REQUEST_BYTES = 16 * 1024;

export interface DebtHttpServerAddress {
	host: string;
	port: number;
}

export interface DebtHttpServerOptions {
	repository: DebtRepository;
	host?: string;
	port?: number;
}

interface BrowserCaptureRequest {
	url: string;
	title: string;
	why_saved: string;
}

class HttpError extends Error {
	readonly status: number;
	readonly code: string;

	constructor(status: number, code: string, message: string) {
		super(message);
		this.status = status;
		this.code = code;
	}
}

function isAllowedOrigin(origin: string | undefined): boolean {
	return origin === undefined || origin.startsWith("chrome-extension://") || origin.startsWith("edge-extension://");
}

function applyCors(request: IncomingMessage, response: ServerResponse): void {
	const origin = request.headers.origin;
	if (origin) {
		response.setHeader("Access-Control-Allow-Origin", origin);
		response.setHeader("Vary", "Origin");
	}
	response.setHeader("Access-Control-Allow-Headers", "Content-Type");
	response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(`${JSON.stringify(body)}\n`);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
	if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
		throw new HttpError(415, "unsupported_media_type", "Content-Type must be application/json");
	}

	const chunks: Buffer[] = [];
	let size = 0;
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		size += buffer.length;
		if (size > MAX_REQUEST_BYTES) {
			throw new HttpError(413, "request_too_large", `Request body must not exceed ${MAX_REQUEST_BYTES} bytes`);
		}
		chunks.push(buffer);
	}

	try {
		return JSON.parse(Buffer.concat(chunks).toString("utf8"));
	} catch {
		throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
	}
}

function requireString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new HttpError(400, "invalid_request", `${field} must be a non-empty string`);
	}
	const normalized = value.trim();
	if (normalized.length > maxLength) {
		throw new HttpError(400, "invalid_request", `${field} must not exceed ${maxLength} characters`);
	}
	return normalized;
}

function parseCaptureRequest(value: unknown): BrowserCaptureRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new HttpError(400, "invalid_request", "Request body must be a JSON object");
	}
	const body = value as Record<string, unknown>;
	const url = requireString(body.url, "url", 4096);
	const title = requireString(body.title, "title", 512);
	const whySaved = requireString(body.why_saved, "why_saved", 4000);

	let parsedUrl: URL;
	try {
		parsedUrl = new URL(url);
	} catch {
		throw new HttpError(400, "invalid_request", "url must be a valid HTTP or HTTPS URL");
	}
	if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
		throw new HttpError(400, "invalid_request", "url must be a valid HTTP or HTTPS URL");
	}

	return { url: parsedUrl.toString(), title, why_saved: whySaved };
}

export class DebtHttpServer {
	private readonly host: string;
	private readonly port: number;
	private readonly service: DebtService;
	private server: Server | undefined;

	constructor(options: DebtHttpServerOptions) {
		this.host = options.host ?? DEFAULT_HOST;
		this.port = options.port ?? DEFAULT_INFO_DEBT_HTTP_PORT;
		if (this.host !== DEFAULT_HOST) {
			throw new Error(`Information Debt HTTP API may only bind to ${DEFAULT_HOST}`);
		}
		this.service = new DebtService(options.repository);
	}

	async start(): Promise<DebtHttpServerAddress> {
		if (this.server) throw new Error("Information Debt HTTP API is already running");
		const server = createServer((request, response) => {
			void this.handleRequest(request, response);
		});
		this.server = server;

		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				server.off("listening", onListening);
				reject(error);
			};
			const onListening = () => {
				server.off("error", onError);
				resolve();
			};
			server.once("error", onError);
			server.once("listening", onListening);
			server.listen(this.port, this.host);
		});

		const address = server.address() as AddressInfo;
		return { host: this.host, port: address.port };
	}

	async stop(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		if (!server) return;
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	}

	private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			if (!isAllowedOrigin(request.headers.origin)) {
				throw new HttpError(403, "origin_not_allowed", "Only Chromium extension origins are allowed");
			}
			applyCors(request, response);

			if (request.method === "OPTIONS") {
				response.writeHead(204);
				response.end();
				return;
			}
			if (request.method === "GET" && request.url === "/health") {
				sendJson(response, 200, { status: "ok" });
				return;
			}
			if (request.method === "POST" && request.url === "/v1/debts") {
				const input = parseCaptureRequest(await readJson(request));
				const item = await this.service.capture({
					title: input.title,
					sourceType: "web",
					sourceUrl: input.url,
					debtType: "discovery",
					whySaved: input.why_saved,
				});
				sendJson(response, 201, { debt: { id: item.id, title: item.title, status: item.status } });
				return;
			}
			throw new HttpError(404, "not_found", "Route not found");
		} catch (error) {
			if (error instanceof HttpError) {
				sendJson(response, error.status, { error: { code: error.code, message: error.message } });
				return;
			}
			const message = error instanceof Error ? error.message : "Unknown error";
			sendJson(response, 500, { error: { code: "internal_error", message } });
		}
	}
}

export function parseInfoDebtHttpPort(value: string | undefined): number {
	if (value === undefined || value === "") return DEFAULT_INFO_DEBT_HTTP_PORT;
	const port = Number(value);
	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error(`PI_INFO_DEBT_HTTP_PORT must be an integer from 1 to 65535, got: ${value}`);
	}
	return port;
}
