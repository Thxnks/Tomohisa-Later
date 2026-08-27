import type { InlineExtension } from "../core/extensions/types.ts";
import infoDebtExtension from "./info-debt/index.ts";
import llamaExtension from "./llama/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "info-debt", factory: infoDebtExtension, hidden: true },
];
