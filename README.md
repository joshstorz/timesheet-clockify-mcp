# timesheet-clockify-mcp

A personal-timesheet MCP server for [Clockify](https://clockify.me/). Lets any MCP-compatible AI assistant (Claude Desktop, Claude Code, Cursor, etc.) start and stop your timers, log past time, and pull billing-ready reports.

This is a **personal time-logging** tool, not an admin/HR tool. It focuses on the verbs you use day-to-day: start, stop, log, edit, list, and report. No workspace administration, no employee management.

## Install

```jsonc
// In your MCP client config (e.g. Claude Desktop's claude_desktop_config.json
// or Claude Code's mcp section)
{
  "mcpServers": {
    "timesheet": {
      "command": "npx",
      "args": ["-y", "timesheet-clockify-mcp"],
      "env": {
        "CLOCKIFY_API_TOKEN": "your-clockify-api-key"
      }
    }
  }
}
```

Get your API token at **clockify.me → profile (top right) → Profile settings → scroll to API → Generate**.

## Optional environment variables

| Variable | Purpose |
|---|---|
| `CLOCKIFY_API_TOKEN` | Required. Your personal Clockify API key. |
| `CLOCKIFY_DEFAULT_PROJECT` | Name or id of a project to use when `start-timer` is called without a `project` argument. |
| `CLOCKIFY_WORKSPACE_ID` | Override the workspace. Defaults to your active workspace. Only needed if you belong to multiple workspaces and want to pin a non-default one. |
| `CLOCKIFY_DEFAULT_BILLABLE` | Set to `true` (or `false`) to control whether new entries are billable when the `billable` argument is omitted. Overrides the project's billable setting. |

## Billable behavior

When `start-timer` or `log-past-entry` is called without an explicit `billable` argument, the value is resolved in this order:

1. `CLOCKIFY_DEFAULT_BILLABLE` env var, if set
2. The project's own billable setting, if a project was given
3. Clockify's API default (**not billable**)

If you bill for everything, set `CLOCKIFY_DEFAULT_BILLABLE=true` and you can never silently lose billable hours to a forgotten flag.

## Tools

### Identity
- **me** — Show the connected user, their email, and the active workspace id.

### Timer
- **start-timer** — Start a new running entry. Args: `description`, `project` (name or id), `task`, `tags`, `billable`.
- **stop-timer** — Stop the running timer. Optional `task` supplies or replaces a required task; optional `end` closes it at its actual historical end. Preserves the entry's other fields.
- **current-timer** — Show what's running right now and how long it's been going.
- **log-past-entry** — Log time you forgot to track. Requires explicit `start` and `end`.
- **edit-entry** — Edit an existing entry by id.
- **delete-entry** — Delete an entry by id.

### Lookups
- **list-entries** — Recent entries with start/end timestamps. Defaults to today. Pass `start`/`end` for a custom range, or `inProgress: true` to only see the running timer.
- **list-projects** — Projects in the workspace. Optional name filter.
- **list-tasks** — Tasks inside a project, with a fallback to your time-entry history when task listing is forbidden. Optional `name` filters results; `refresh: true` forces rediscovery.
- **list-tags** — Tags available in the workspace.

### Reports
- **summary-report** — Aggregate totals for a date range, grouped by `PROJECT`, `CLIENT`, `TAG`, `TASK`, `USER`, or `DATE`. Use for "how did I spend April" or "what should I bill this month".
- **detailed-report** — Every individual entry in a range, with computed durations and billable amounts. Use for "what specifically did I bill Client X for in April".

## Name vs id

Anywhere a `project`, `task`, or tag is accepted, you can pass either:
- The exact name (case-insensitive). If a single project's name contains the string, it's auto-selected. If multiple match, the tool returns the candidates so the assistant can pick.
- The 24-character hex id from Clockify.

## Task discovery and refresh

Some accounts can read and use individual tasks but receive HTTP 403 when listing
a project's tasks. In that case, this server reads the connected user's own
time entries for that project with `hydrated=true`, which can include the task's
ID, name, and status. These filters are part of the [Clockify API](https://docs.clockify.me/).
If an entry only contains a task ID, it attempts a direct task lookup.

Discovery works with any connected account. There are no built-in project IDs,
task IDs, or billing defaults tied to a particular account. The cache lives only
in memory, belongs to one API client, and is separated by user, workspace, and
project. It holds at most 256 project catalogs; nothing is written to disk.

- Catalogs expire after **five minutes**, and refresh on the next lookup.
- A task name missing from the cache triggers rediscovery immediately.
- `list-tasks(project: "Example project", refresh: true)` forces a fresh lookup.
- Successful entry writes and task-validation failures invalidate the affected
  project's cache. Restarting the MCP clears all cached catalogs.
- With normal task-list permission, new tasks are visible on refresh even before
  their first use. When listing is forbidden, a new task becomes discoverable
  after it appears in **your own time-entry history**. Until then, supply its ID
  directly or first use it in the Clockify app, then refresh.

History results are explicitly marked as a **partial catalog**. Discovery scans
up to 2,000 recent entries per project and reports when it reaches that limit.
Task reads are retried on refresh, so a later permission change also takes effect.
The active workspace is rechecked after one minute unless pinned with
`CLOCKIFY_WORKSPACE_ID`.

Before a supplied task is used, the server checks its current details when
permitted. If detail reads are also forbidden, it passes the known ID to Clockify
and lets Clockify validate the write. Completed or ambiguous tasks require an
explicit choice; the server never substitutes a different billing code or infers
a default from the most recent entry. Pass `task` when choosing a billing code.

## Recover a timer that requires a task

If a task became required or the previous task was completed, a stop can fail
even though the timer is already running. List the project's tasks, then retry
with an active task and the intended end time:

```text
list-tasks(project: "Example project", refresh: true)
stop-timer(task: "Development", end: "2026-01-01T10:00:00Z")
```

An explicit task ID also works when task-list and task-detail reads are forbidden.
The server reads the running entry and updates that specific ID, preserving its
start, description, project, billable flag, tags, entry type, and custom fields.
The end must be after its start. A failed write is not automatically retried.

Task-required errors from start, stop, log, and edit include structured recovery
details: entry/project IDs, existing and attempted task IDs, requested end, and
available active tasks. Permission failures and other validation errors keep
their original meaning. Entry summaries always show the raw task ID (or `null`)
and distinguish an absent task from a forbidden name lookup.

After upgrading, **restart or reconnect the MCP server in each client**. Existing
processes keep their loaded code; rebuilding `dist/` does not update them. Check
that `list-tasks` advertises `refresh` and `stop-timer` advertises `task` and `end`.

## Example prompts

> "Start a timer on Acme website redesign — I'm doing copy edits."

> "Stop the timer."

> "What am I working on right now?"

> "Log 9am to 10:30am today on the Acme project, billable, description: client call."

> "Give me an April summary grouped by client, billable only."

> "List my entries from yesterday."

## Local development

```bash
git clone https://github.com/joshstorz/timesheet-clockify-mcp.git
cd timesheet-clockify-mcp
npm install
npm test
CLOCKIFY_API_TOKEN=xxx npm run dev
```

Tests use synthetic accounts and a mocked Clockify API; no API key or live time
entries are needed. Publishing runs the build and test suite automatically.

## License

MIT
