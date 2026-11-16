import { createPool, type Pool } from "mysql2/promise";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionShutdownEvent,
} from "../src/core/extensions/types.ts";
import { getDebtRepository, retainDebtRepository } from "../src/extensions/info-debt/db.ts";
import infoDebtExtension from "../src/extensions/info-debt/index.ts";
import materialsExtension from "../src/extensions/materials/index.ts";

vi.mock("mysql2/promise", () => ({ createPool: vi.fn() }));

const shutdownHandlers: ExtensionHandler<SessionShutdownEvent>[] = [];
const releases: Array<() => Promise<void>> = [];
const context = {} as ExtensionContext;

afterEach(async () => {
	for (const handler of shutdownHandlers.splice(0))
		await handler({ type: "session_shutdown", reason: "quit" }, context);
	for (const release of releases.splice(0)) await release();
	vi.clearAllMocks();
});

function loadExtension(factory: (pi: ExtensionAPI) => void): ExtensionHandler<SessionShutdownEvent> {
	let shutdown: ExtensionHandler<SessionShutdownEvent> | undefined;
	factory({
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		on(event: string, handler: ExtensionHandler<SessionShutdownEvent>) {
			if (event === "session_shutdown") shutdown = handler;
		},
	} as unknown as ExtensionAPI);
	if (!shutdown) throw new Error("Extension did not register database cleanup");
	shutdownHandlers.push(shutdown);
	return shutdown;
}

describe("shared database lifecycle", () => {
	it.each([infoDebtExtension, materialsExtension])(
		"closes the pool when a standalone extension exits",
		async (factory) => {
			const end = vi.fn().mockResolvedValue(undefined);
			vi.mocked(createPool).mockReturnValue({ end } as unknown as Pool);
			const shutdown = loadExtension(factory);
			await shutdown({ type: "session_shutdown", reason: "quit" }, context);
			expect(end).toHaveBeenCalledTimes(1);
		},
	);

	it("keeps the pool open for another session and ignores repeated shutdown events", async () => {
		const end = vi.fn().mockResolvedValue(undefined);
		vi.mocked(createPool).mockReturnValue({ end } as unknown as Pool);
		const firstDebt = loadExtension(infoDebtExtension);
		const firstMaterials = loadExtension(materialsExtension);
		const secondDebt = loadExtension(infoDebtExtension);
		const secondMaterials = loadExtension(materialsExtension);
		const repository = getDebtRepository();
		await firstDebt({ type: "session_shutdown", reason: "quit" }, context);
		await firstMaterials({ type: "session_shutdown", reason: "quit" }, context);
		await firstMaterials({ type: "session_shutdown", reason: "quit" }, context);
		expect(end).not.toHaveBeenCalled();
		expect(getDebtRepository()).toBe(repository);
		await secondMaterials({ type: "session_shutdown", reason: "quit" }, context);
		expect(end).not.toHaveBeenCalled();
		await secondDebt({ type: "session_shutdown", reason: "quit" }, context);
		expect(end).toHaveBeenCalledTimes(1);
		expect(createPool).toHaveBeenCalledTimes(1);
	});

	it.each(["quit", "reload", "new", "resume", "fork"] as const)("creates a fresh pool after %s", async (reason) => {
		const end = vi.fn().mockResolvedValue(undefined);
		vi.mocked(createPool).mockImplementation(() => ({ end }) as unknown as Pool);
		const shutdown = loadExtension(materialsExtension);
		const oldRepository = getDebtRepository();
		await shutdown({ type: "session_shutdown", reason }, context);
		const nextShutdown = loadExtension(infoDebtExtension);
		expect(getDebtRepository()).not.toBe(oldRepository);
		expect(createPool).toHaveBeenCalledTimes(2);
		await nextShutdown({ type: "session_shutdown", reason: "quit" }, context);
		expect(end).toHaveBeenCalledTimes(2);
	});

	it("waits for pool shutdown while a new session can acquire a fresh repository", async () => {
		let finish: () => void = () => {
			throw new Error("Pool close has not started");
		};
		const end = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		vi.mocked(createPool).mockReturnValueOnce({ end } as unknown as Pool);
		const first = retainDebtRepository();
		releases.push(first.release);
		const closing = first.release();
		let closed = false;
		void closing.then(() => {
			closed = true;
		});
		await Promise.resolve();
		expect(closed).toBe(false);
		vi.mocked(createPool).mockReturnValue({ end: vi.fn().mockResolvedValue(undefined) } as unknown as Pool);
		const next = retainDebtRepository();
		releases.push(next.release);
		expect(next.repository).not.toBe(first.repository);
		finish();
		await closing;
		expect(closed).toBe(true);
	});
});
