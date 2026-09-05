# Handover: task discovery and task-required timer recovery

Updated 2026-09-05. Target release: `timesheet-clockify-mcp` v0.2.3.

## Incident status

The original running-timer incident was manually closed before this work. The
old instruction to stop that timer is obsolete. This release does not modify
historical billing records. Account-specific identifiers and meeting details
have been removed from this public document.

The previous headless repair stopped at its 20-turn limit immediately after
editing the source. It did not build, restart the MCP, or publish the change.
That partial patch included account-specific default task IDs; they have been
removed rather than distributed in a public package.

## Confirmed causes

- A valid API key can list projects and read individual tasks while the task-list
  endpoint returns HTTP 403.
- Own time-entry history with `hydrated=true` can expose task IDs, names, and
  status despite that list restriction. Direct task-ID reads also work when
  permitted. No replacement key is needed for this fallback.
- Clockify can reject an entry write with HTTP 400, code 501 when an active task
  is required or the supplied task was completed.
- HTTP 403 can also contain code 501, so the numeric code alone does not identify
  a task-required error. The HTTP status and task-validation message matter.

## Implemented behavior

- Discover normally through the paginated task list; on HTTP 403, scan the
  connected user's hydrated history for that project (up to 2,000 entries).
- Keep an in-memory cache scoped to API-client instance, workspace, user, and
  project, with a five-minute TTL and at most 256 catalogs. Never persist account
  data or supply account-specific defaults.
- Refresh on a name miss, `list-tasks(refresh=true)`, expiry, successful writes,
  and task-validation failures. Expiry and invalidation refresh on next use.
- Label history results as partial, including whether the scan limit was reached.
  A task never used by the connected user needs task-list permission, first use
  in Clockify, or an explicit ID. This limitation is not hidden by caching.
- Recheck selected task details before writes when permitted. Do not replace a
  completed or ambiguous task with a different billing code. Explicit IDs remain
  usable when task reads are forbidden; Clockify validates the write.
- `stop-timer(task?, end?)` reads the running entry and updates that specific ID,
  preserving its fields and supporting an explicit historical end. There is no
  blind current-timer PATCH or automatic write retry.
- Start, stop, log, and edit return actionable structured task-required errors.
  Entries expose raw task IDs and distinguish null tasks from failed name reads.
- Name lookup failures after successful writes cannot turn success into failure.
- Project changes during an edit clear the previous project's task association.

## Verification and release

- Automated tests cover discovery/refresh, account isolation, API pagination,
  cache expiry, new and renamed tasks, completed/ambiguous tasks, permission
  failures, all entry-writing tools, one-hour historical recovery, field
  preservation, failed-write integrity, and package CLI startup through a symlink.
- Tests use synthetic IDs and a mocked API. `npm test` builds and runs them;
  `prepublishOnly` runs the same checks. GitHub Actions covers Node 18 and 22.
- Before release, verify discovery against the connected account with read-only
  calls through a freshly started MCP process. Do not create test billing entries.
- Publish and verify the package, sync GitHub, and confirm the release version
  through a new MCP handshake. Existing MCP clients must reconnect/restart to
  load the new code. A changed `src/` or `dist/` is not a process restart.

Verified locally:

- All 45 automated tests pass.
- A freshly started stdio MCP advertises v0.2.3 and the new arguments.
- Read-only live discovery fell back to history and found active tasks, including
  a task-name filter hit, with the existing API key. No billing records changed.
- The connected account had no running timer during verification.

GitHub CI and npm publication are the remaining release steps. Existing client
processes still need to reconnect; the fresh-process check does not reload them.
