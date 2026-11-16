import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Immutable blobs. Database file names are labels and never become paths. */
export class LocalAssetStore {
	private readonly root: string;

	constructor(root: string) {
		this.root = resolve(root);
	}

	async put(data: Uint8Array): Promise<{ sha256: string; size: number }> {
		const sha256 = createHash("sha256").update(data).digest("hex");
		const dir = join(this.root, sha256.slice(0, 2));
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const temporary = join(dir, `.${randomUUID()}.tmp`);
		await writeFile(temporary, data, { flag: "wx", mode: 0o600 });
		try {
			// Publishing a complete file with link() never overwrites an existing blob.
			try {
				await link(temporary, this.getPath(sha256));
			} catch (error) {
				if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
				await this.read(sha256);
			}
		} finally {
			await unlink(temporary);
		}
		return { sha256, size: data.byteLength };
	}

	async read(sha256: string): Promise<Buffer> {
		const data = await readFile(this.getPath(sha256));
		if (createHash("sha256").update(data).digest("hex") !== sha256) {
			throw new Error(`Asset integrity check failed: ${sha256}`);
		}
		return data;
	}

	getPath(sha256: string): string {
		if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("Invalid asset hash");
		return join(this.root, sha256.slice(0, 2), sha256);
	}
}
