import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { harness, id, WORKSPACE as W, USER as U, PROJECT as P, TASK as T, ENTRY as E, START, END, project, task, entry, text, writes, historyCalls, response } from "./helpers.mjs";

test("MCP advertises its actual package version and new recovery/refresh arguments", async t => {
  const h = await harness(t);
  assert.equal(h.client.getServerVersion().version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
  const { tools } = await h.client.listTools();
  assert.ok(tools.find(t => t.name === "stop-timer").inputSchema.properties.task);
  assert.ok(tools.find(t => t.name === "stop-timer").inputSchema.properties.end);
  assert.ok(tools.find(t => t.name === "list-tasks").inputSchema.properties.refresh);
});

test("the npm-style symlink entry point runs the CLI instead of silently exiting", () => {
  const dir = mkdtempSync(join(tmpdir(), "clockify-cli-test-"));
  try {
    const bin = join(dir, "timesheet-clockify-mcp");
    symlinkSync(resolve("dist/index.js"), bin);
    const env = { ...process.env };
    delete env.CLOCKIFY_API_TOKEN;
    const result = spawnSync(process.execPath, [bin], { env, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Missing CLOCKIFY_API_TOKEN/);
  } finally { rmSync(dir, { recursive: true }); }
});

test("list-tasks exposes partial history, refreshes new tasks, and returns IDs", async t => {
  const h = await harness(t, { taskListStatus: 403, entries: [entry()] });
  const result = await h.call("list-tasks", { project: P });
  assert.equal(result.structuredContent.source, "history");
  assert.equal(result.structuredContent.partial, true);
  assert.equal(result.structuredContent.tasks[0].id, T);
  h.state.tasks.push(task({ id: id(8), name: "New task" }));
  h.state.entries.push(entry({ id: id(9), taskId: id(8) }));
  const refreshed = await h.call("list-tasks", { project: P, refresh: true });
  assert.equal(refreshed.structuredContent.tasks.length, 2);
  assert.equal(writes(h.state).length, 0);
});

test("normal stop succeeds without a task requirement and addresses a specific entry", async t => {
  const h = await harness(t, { entries: [entry({ taskId: null, tagIds: null })] });
  const result = await h.call("stop-timer", { end: END });
  assert.ok(!result.isError);
  assert.match(text(result), /Stopped/);
  assert.equal(writes(h.state).length, 1);
  assert.equal(writes(h.state)[0].method, "PUT");
  assert.ok(writes(h.state)[0].url.pathname.endsWith(`/time-entries/${E}`));
  assert.equal(h.state.entries[0].taskId, null);
  assert.match(text(await h.call("current-timer")), /No timer running/);
});

test("stopping an entry with an existing active task preserves all supported fields and exactly one hour", async t => {
  const existing = entry({ type: "REGULAR", customFieldValues: [{ customFieldId: id(7), value: "custom value", name: "Extra read-only metadata" }] });
  const h = await harness(t, { requiresTask: true, entries: [existing] });
  const result = await h.call("stop-timer", { end: END });
  assert.ok(!result.isError);
  const sent = writes(h.state)[0].body;
  assert.deepEqual(sent, {
    start: START, end: END, projectId: P, taskId: T, description: existing.description,
    billable: true, tagIds: existing.tagIds, type: "REGULAR",
    customFields: [{ customFieldId: id(7), value: "custom value" }],
  });
  assert.equal(h.state.entries[0].timeInterval.duration, "PT3600S");
  assert.match(text(result), /\(1h\)/);
});

test("legacy taskless timer returns structured recovery and remains unchanged until explicitly retried", async t => {
  const existing = entry({ taskId: null });
  const history = entry({ id: id(9), timeInterval: { start: "2025-12-01T09:00:00Z", end: "2025-12-01T10:00:00Z" } });
  const h = await harness(t, { requiresTask: true, taskListStatus: 403, entries: [existing, history] });
  const result = await h.call("stop-timer", { end: END });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.error, "TASK_REQUIRED_OR_COMPLETED");
  assert.equal(result.structuredContent.entryId, E);
  assert.equal(result.structuredContent.existingTaskId, null);
  assert.equal(result.structuredContent.projectId, P);
  assert.equal(result.structuredContent.projectName, "Example project");
  assert.equal(result.structuredContent.requestedEnd, END);
  assert.equal(result.structuredContent.availableTasks[0].id, T);
  assert.deepEqual(h.state.entries[0], existing);
  assert.equal(writes(h.state).length, 1);
  const repaired = await h.call("stop-timer", { task: "Development", end: END });
  assert.ok(!repaired.isError);
  assert.equal(h.state.entries[0].taskId, T);
  assert.equal(h.state.entries[0].timeInterval.duration, "PT3600S");
});

test("a completed task is reported without substitution and can be explicitly replaced at stop", async t => {
  const h = await harness(t, {
    requiresTask: true, tasks: [task({ status: "DONE" }), task({ id: id(8), name: "Replacement" })], entries: [entry()],
  });
  const failed = await h.call("stop-timer", { end: END });
  assert.equal(failed.structuredContent.error, "TASK_REQUIRED_OR_COMPLETED");
  assert.equal(failed.structuredContent.existingTaskId, T);
  assert.deepEqual(failed.structuredContent.availableTasks.map(t => t.id), [id(8)]);
  assert.equal(h.state.entries[0].timeInterval.end, null);
  const result = await h.call("stop-timer", { task: "Replacement", end: END });
  assert.ok(!result.isError);
  assert.equal(h.state.entries[0].taskId, id(8));
});

test("stop accepts an explicit valid ID even when task list and detail both return 403", async t => {
  const h = await harness(t, { requiresTask: true, taskListStatus: 403, taskDetailStatus: 403, entries: [entry({ taskId: null })] });
  const result = await h.call("stop-timer", { task: T, end: END });
  assert.ok(!result.isError);
  assert.equal(h.state.entries[0].taskId, T);
  assert.match(text(result), /name lookup forbidden/);
});

test("failed recovery with an unverifiable bad ID does not modify the entry or automatically retry", async t => {
  const existing = entry({ taskId: null });
  const h = await harness(t, { requiresTask: true, taskListStatus: 403, taskDetailStatus: 403, entries: [existing] });
  const result = await h.call("stop-timer", { task: id(999), end: END });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.attemptedTaskId, id(999));
  assert.deepEqual(h.state.entries[0], existing);
  assert.equal(writes(h.state).length, 1);
});

test("invalid historical end is rejected before any mutation", async t => {
  const h = await harness(t, { entries: [entry()] });
  const result = await h.call("stop-timer", { end: "2026-01-01T08:00:00Z" });
  assert.equal(result.isError, true);
  assert.match(text(result), /End time must be after/);
  assert.equal(writes(h.state).length, 0);
});

test("an entry stopped between the list and detail reads is not overwritten", async t => {
  const h = await harness(t, { entries: [entry()], intercept: (c, state) => {
    if (c.method === "GET" && c.url.pathname.endsWith(`/time-entries/${E}`)) {
      state.entries[0].timeInterval.end = END;
    }
  } });
  assert.match(text(await h.call("stop-timer", { end: END })), /already stopped/);
  assert.equal(writes(h.state).length, 0);
});

test("no current timer performs no write", async t => {
  const h = await harness(t);
  assert.match(text(await h.call("stop-timer")), /No timer was running/);
  assert.equal(writes(h.state).length, 0);
});

for (const [status, body] of [
  [400, { code: 501, message: "Description is required" }],
  [403, { code: 501, message: "Access Denied" }],
  [404, { message: "Entry no longer exists" }],
  [429, { message: "Too many requests" }],
]) test(`unrelated stop error ${status}/${body.message} is not reported as task-required or no-timer`, async t => {
  const h = await harness(t, { entries: [entry()], intercept: c => c.method === "PUT" ? response(body, status) : undefined });
  const result = await h.call("stop-timer", { end: END });
  assert.equal(result.isError, true);
  assert.ok(!result.structuredContent);
  assert.match(text(result), new RegExp(String(status)));
  assert.equal(writes(h.state).length, 1);
});

for (const tool of ["start-timer", "log-past-entry", "edit-entry"]) {
  test(`${tool} resolves task names from history despite a forbidden list`, async t => {
    const h = await harness(t, { requiresTask: true, taskListStatus: 403, entries: [entry({ timeInterval: { start: START, end: END } })] });
    const args = tool === "edit-entry" ? { entryId: E, task: "Development", description: "Updated" }
      : { project: P, task: "Development", ...(tool === "log-past-entry" ? { start: START, end: END } : {}) };
    const result = await h.call(tool, args);
    assert.ok(!result.isError, text(result));
    assert.equal(writes(h.state)[0].body.taskId, T);
    assert.equal(writes(h.state)[0].body.billable, true);
  });
  test(`${tool} returns actionable task-required errors when the task is missing`, async t => {
    const h = await harness(t, { requiresTask: true, entries: [entry({ taskId: null })] });
    const args = tool === "edit-entry" ? { entryId: E, end: END }
      : { project: P, ...(tool === "log-past-entry" ? { start: START, end: END } : {}) };
    const result = await h.call(tool, args);
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error, "TASK_REQUIRED_OR_COMPLETED");
    assert.equal(result.structuredContent.operation, tool);
    assert.equal(writes(h.state).length, 1);
  });
}

test("editing an entry into another project does not reuse the old task ID", async t => {
  const h = await harness(t, { projects: [project(), project({ id: id(8), name: "Second" })], entries: [entry()] });
  const result = await h.call("edit-entry", { entryId: E, project: id(8), end: END });
  assert.ok(!result.isError);
  assert.equal(writes(h.state)[0].body.taskId, null);
  assert.equal(writes(h.state)[0].body.projectId, id(8));
});

test("a successful write is still reported successful when every label lookup fails", async t => {
  let writeSucceeded = false;
  const h = await harness(t, { entries: [entry()], intercept: c => {
    if (c.method === "PUT") writeSucceeded = true;
    if (writeSucceeded && c.method === "GET") return response({ message: "Temporarily unavailable" }, 500);
  } });
  const result = await h.call("stop-timer", { end: END });
  assert.ok(!result.isError, text(result));
  assert.match(text(result), /Stopped/);
  assert.equal(writes(h.state).length, 1);
});

test("current-timer and list-entries distinguish null tasks from forbidden task names", async t => {
  const h = await harness(t, { hydrate: false, taskDetailStatus: 403, entries: [entry()] });
  let result = await h.call("current-timer");
  assert.match(text(result), new RegExp(`taskId: ${T}; name lookup forbidden`));
  result = await h.call("list-entries", { inProgress: true });
  assert.match(text(result), /name lookup forbidden/);
  assert.equal(historyCalls(h.state).at(-1).url.searchParams.has("start"), false);
  h.state.entries[0].taskId = null;
  result = await h.call("current-timer");
  assert.match(text(result), /taskId: null; no task assigned/);
});

test("successful writes invalidate discovery so a first-use task appears immediately", async t => {
  const h = await harness(t, { taskListStatus: 403 });
  assert.equal((await h.call("list-tasks", { project: P })).structuredContent.tasks.length, 0);
  const result = await h.call("log-past-entry", { project: P, task: T, start: START, end: END });
  assert.ok(!result.isError);
  assert.equal((await h.call("list-tasks", { project: P })).structuredContent.tasks[0].id, T);
});

test("task discovery cannot hide an authentication failure or create an entry on a name miss", async t => {
  const h = await harness(t, { taskListStatus: 401 });
  const result = await h.call("log-past-entry", { project: P, task: "Development", start: START, end: END });
  assert.equal(result.isError, true);
  assert.match(text(result), /401/);
  assert.equal(writes(h.state).length, 0);
});

test("a missing project with a supplied task is rejected without writing", async t => {
  const h = await harness(t);
  const result = await h.call("log-past-entry", { task: T, start: START, end: END });
  assert.equal(result.isError, true);
  assert.equal(writes(h.state).length, 0);
});
