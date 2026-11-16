/**
 * Information Debt extension.
 *
 * Tracks "information worth keeping but not handled right now": articles,
 * links, papers, tasks, ideas. Long-term state lives in MySQL; pi sessions
 * only hold the execution trajectory, so session compaction or deletion never
 * loses debt data.
 *
 * Tools: capture_debt, list_debts, get_debt, search_debts, update_debt,
 *        resolve_debt
 * Commands: /inbox, /review [minutes]
 *
 * Built into Pi and loaded automatically.
 */

import type { ExtensionAPI } from "../../core/extensions/types.ts";
import { registerDebtCommands } from "./commands.ts";
import { type DebtRepository, retainDebtRepository } from "./db.ts";
import { registerDebtTools } from "./tools.ts";

export default function infoDebtExtension(pi: ExtensionAPI, providedRepository?: DebtRepository): void {
	const shared = providedRepository ? undefined : retainDebtRepository();
	const repository = providedRepository ?? shared!.repository;
	if (shared) pi.on("session_shutdown", () => shared.release());
	registerDebtTools(pi, repository);
	registerDebtCommands(pi, repository);
}
