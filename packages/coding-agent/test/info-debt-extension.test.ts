import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { builtInExtensions } from "../src/extensions/index.ts";
import infoDebtExtension from "../src/extensions/info-debt/index.ts";

describe("information debt extension", () => {
	it("is bundled and registers its tools and commands", async () => {
		expect(
			builtInExtensions.some((extension) => typeof extension !== "function" && extension.name === "info-debt"),
		).toBe(true);

		const extension = await loadExtensionFromFactory(
			infoDebtExtension,
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"<inline:info-debt>",
		);

		expect([...extension.commands.keys()]).toEqual(["inbox", "review"]);
		expect([...extension.tools.keys()]).toEqual([
			"capture_debt",
			"list_debts",
			"get_debt",
			"search_debts",
			"update_debt",
			"resolve_debt",
		]);
	});
});
