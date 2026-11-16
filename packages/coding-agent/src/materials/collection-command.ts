import { execFile } from "node:child_process";

export interface CollectionCommandResult {
	stdout: string;
	code: number;
}

export type CollectionCommand = (
	command: string,
	args: string[],
	signal?: AbortSignal,
	env?: Record<string, string>,
) => Promise<CollectionCommandResult>;

export class CollectionError extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}

/** Arguments are never evaluated by a shell. Output and execution time are bounded. */
export const runCollectionCommand: CollectionCommand = (command, args, signal, env) =>
	new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new CollectionError("CANCELLED"));
			return;
		}
		execFile(
			command,
			args,
			{
				encoding: "utf8",
				maxBuffer: 4 * 1024 * 1024,
				timeout: 120_000,
				killSignal: "SIGKILL",
				windowsHide: true,
				signal,
				env: env ? { ...process.env, ...env } : process.env,
			},
			(error, stdout) => {
				if (signal?.aborted) {
					reject(new CollectionError("CANCELLED"));
					return;
				}
				if (error?.code === "ENOENT") {
					reject(new CollectionError("NEED_SETUP"));
					return;
				}
				if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
					reject(new CollectionError("OUTPUT_LIMIT"));
					return;
				}
				if (error?.killed) {
					reject(new CollectionError("TIMEOUT"));
					return;
				}
				// Structured upstream errors are returned even when the process exits nonzero.
				resolve({ stdout, code: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
			},
		);
	});
