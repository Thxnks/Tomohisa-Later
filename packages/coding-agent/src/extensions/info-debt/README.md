# Information Debt (Built In)

Tracks "information worth keeping but not handled right now": articles, links,
papers, school tasks, ideas. Not a bookmark list and not a todo list — each
item records what it is, why it was saved, which project it relates to, the
next step, and when it is worth revisiting.

## Architecture

Two strictly separated stores:

- **MySQL debt store** — long-term business state and the single source of
  truth. The default connection is `root@127.0.0.1:3306/tomohisa_helper`.
- **Pi session** — execution trajectory only (messages, tool results). Tool
  results returned to the LLM are compact; the model re-queries the database
  for current truth, so session branching, compaction, or deletion never
  affects debt data.

## Availability

Information Debt is bundled with Pi and loads automatically. Its database is
global and cross-project.

## MySQL configuration

Create the schema once:

```sql
CREATE DATABASE IF NOT EXISTS tomohisa_helper
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
```

Set the password in the terminal before starting Pi. Do not put it in source
control:

```powershell
$env:PI_INFO_DEBT_MYSQL_PASSWORD="your-password"
```

These optional variables override the built-in defaults:

| Variable | Default |
|----------|---------|
| `PI_INFO_DEBT_MYSQL_HOST` | `127.0.0.1` |
| `PI_INFO_DEBT_MYSQL_PORT` | `3306` |
| `PI_INFO_DEBT_MYSQL_USER` | `root` |
| `PI_INFO_DEBT_MYSQL_DATABASE` | `tomohisa_helper` |

The extension creates and migrates its `debt_meta` and `debt_items` tables on
first use.

## Local HTTP API and browser capture

Start the local browser-capture API from the repository root:

```powershell
npm run info-debt-api
```

It listens only on `http://127.0.0.1:43127` by default. Set
`PI_INFO_DEBT_HTTP_PORT` to use another local port. The API exposes:

- `GET /health`
- `POST /v1/debts` with JSON fields `url`, `title`, and `why_saved`

Browser captures are stored as `web` / `discovery` debt in `inbox` with
priority 3. Install the unpacked Chromium/Edge extension from
`apps/info-debt-browser-extension`; its README contains setup instructions.

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
- `/review [minutes]` — deterministically score eligible debt, keep the Top 10,
  and ask the current agent to recommend a combination within the time budget.
  The default budget is 30 minutes.

## Review Engine

Review has two layers and never invokes a separate LLM:

1. The repository queries at most 100 eligible rows: `inbox`, `active`, and
   `deferred` whose `revisit_at` is due. The candidate selector defensively
   applies the same eligibility rule.
2. The pure scorer ranks those rows. The Review Engine sorts them and keeps the
   Top 10, then `/review` sends compact structured candidate data to the current
   Pi agent for the final budget-aware combination.

Current score:

```text
score = priority_score + urgency_score + age_score - effort_penalty
```

- Priority 1..5 (1 is highest): `(6 - priority) * 3`.
- Deadline: overdue `+30`, within 24h `+20`, within 3 days `+12`, within 7 days
  `+5`.
- Age: `+2` per complete week, capped at `+12`.
- Effort: no penalty up to 125% of the budget; above that, the over-budget
  ratio costs up to `20` points.

The candidate selector, scorer, Top-K size, candidate-pool limit, and final
agent prompt are policy boundaries that can be replaced without changing debt
persistence or the Agent Loop.

## Statuses

`inbox` (default) → `active` → `resolved`; `deferred` (parked, see
`revisit_at`), `archived` (kept for reference, out of the review flow).

## Schema

One table, `debt_items` (snake_case columns mapped to camelCase fields in
`types.ts`). `DebtRepository` owns all MySQL access. Schema version state is
tracked in `debt_meta`.

## Manual lifecycle test

Start Pi from the repository root, log in to a model provider, then send these
requests one at a time:

1. `Use capture_debt to save "Read the MySQL design note" as reading debt for project pi. Why saved: apply it to Information Debt. Next action: extract the migration rules.`
2. `Use list_debts to list inbox debt for project pi.`
3. `Use get_debt with the short id returned above.`
4. `Use search_debts to search for "migration" in project pi.`
5. `Use update_debt on that id: set status to active and next_action to "write the repository test".`
6. `Use get_debt again and verify status is active and next_action changed.`
7. `Use resolve_debt on that id with note "repository lifecycle verified".`
8. `Use get_debt once more and verify status is resolved, resolved_at is set, and resolution_note was saved.`

After step 1, `/inbox` should show the item. After step 7, it should no longer
appear in `/inbox`, while `list_debts` with `status: resolved` should return it.

## Manual review test

Create 5–10 debts through normal prompts that explicitly ask the agent to call
`capture_debt`, then use `update_debt` where a non-inbox status or revisit time
is needed. Vary the fields so the expected order is visible:

1. Priority 1, due in 1 hour, estimated 10 minutes.
2. Priority 2, overdue, estimated 20 minutes.
3. Priority 1, no deadline, estimated 90 minutes.
4. Priority 3, no deadline, estimated 15 minutes (optionally backdate
   `created_at` in MySQL to exercise the age score).
5. Priority 5, no deadline, estimated 10 minutes.
6. A resolved item.
7. An archived item.
8. A deferred item with `revisit_at` tomorrow.
9. A deferred item with `revisit_at` in the past.

Then run `/review 30`. Verify that resolved, archived, and not-yet-revisited
items are absent; the urgent/overdue items rank highly; the 90-minute item is
penalized; and the current agent recommends a combination whose known total
time is no more than about 30 minutes. `/review abc` should show usage help.

## Out of scope (deliberately)

Source Resolver, page-content extraction, OCR, Vision, XHS crawling,
trajectory reduction, platform sync, vector search, knowledge graphs, a
separate Review LLM, automatic status changes, and recommendation logic.
Search is plain SQL `LIKE` for now.
