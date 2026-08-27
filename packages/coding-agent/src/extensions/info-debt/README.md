# Information Debt (Built In)

Tracks "information worth keeping but not handled right now": articles, links,
papers, school tasks, ideas. Not a bookmark list and not a todo list — each
item records what it is, why it was saved, which project it relates to, the
next step, and when it is worth revisiting.

## Architecture

Two strictly separated stores:

- **SQLite debt store** — `<agentDir>/info-debt/debt.db` (default
  `~/.pi/agent/info-debt/debt.db`). Long-term business state and the single
  source of truth. Uses `node:sqlite`, no external dependencies.
- **Pi session** — execution trajectory only (messages, tool results). Tool
  results returned to the LLM are compact; the model re-queries the database
  for current truth, so session branching, compaction, or deletion never
  affects debt data.

## Availability

Information Debt is bundled with Pi and loads automatically. Its database is
global and cross-project.

## Tools

| Tool | Purpose |
|------|---------|
| `capture_debt` | Record a new item (why_saved + next_action encouraged) |
| `list_debts` | List items, filter by status / type / project |
| `get_debt` | Full details by id (8-char short id works) |
| `search_debts` | Substring search over title/summary/why_saved/project/next_action/url |
| `update_debt` | Change fields (status, next_action, priority, ...) |
| `resolve_debt` | Mark resolved, optional note |

## Commands

- `/inbox` — browse open items (inbox + active + due-for-revisit); selecting
  one hands it to the agent to work on.
- `/review [minutes]` — e.g. `/review 30`: the agent picks the debt most
  worth handling within the time budget and starts on it.

## Statuses

`inbox` (default) → `active` → `resolved`; `deferred` (parked, see
`revisit_at`), `archived` (kept for reference, out of the review flow).

## Schema

One table, `debt_items` (snake_case columns mapped to camelCase fields in
`types.ts`). Migrations are numbered entries in `db.ts`, tracked in the
`debt_meta` table — append new migrations, never edit shipped ones.

## Out of scope (deliberately)

Platform sync (xiaohongshu, X API), vector search, knowledge graphs, front-end
apps. Search is plain SQL `LIKE` for now.
