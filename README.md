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
- **stop-timer** — Stop the running timer. Returns the project, description, and duration so you can correct on the spot.
- **current-timer** — Show what's running right now and how long it's been going.
- **log-past-entry** — Log time you forgot to track. Requires explicit `start` and `end`.
- **edit-entry** — Edit an existing entry by id.
- **delete-entry** — Delete an entry by id.

### Lookups
- **list-entries** — Recent entries with start/end timestamps. Defaults to today. Pass `start`/`end` for a custom range, or `inProgress: true` to only see the running timer.
- **list-projects** — Projects in the workspace. Optional name filter.
- **list-tasks** — Tasks inside a project (Clockify lets projects have sub-tasks).
- **list-tags** — Tags available in the workspace.

### Reports
- **summary-report** — Aggregate totals for a date range, grouped by `PROJECT`, `CLIENT`, `TAG`, `TASK`, `USER`, or `DATE`. Use for "how did I spend April" or "what should I bill this month".
- **detailed-report** — Every individual entry in a range, with computed durations and billable amounts. Use for "what specifically did I bill Client X for in April".

## Name vs id

Anywhere a `project`, `task`, or tag is accepted, you can pass either:
- The exact name (case-insensitive). If a single project's name contains the string, it's auto-selected. If multiple match, the tool returns the candidates so the assistant can pick.
- The 24-character hex id from Clockify.

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
CLOCKIFY_API_TOKEN=xxx npm run dev
```

## License

MIT
