import test from "node:test";
import assert from "node:assert/strict";
import { TaskDiscovery } from "../dist/tasks.js";
import { mockApi, id, WORKSPACE as W, USER as U, PROJECT as P, TASK as T, task, entry, historyCalls, response } from "./helpers.mjs";

test("normal project task listing stays paginated and cached", async () => {
  const { api, state } = mockApi({ tasks: Array.from({ length: 201 }, (_, n) => task({ id: id(100 + n), name: `Task ${n}` })) });
  const discovery = new TaskDiscovery(api);
  assert.equal((await discovery.list(W, U, P)).tasks.length, 201);
  await discovery.list(W, U, P);
  assert.equal(state.calls.length, 2);
  assert.equal(historyCalls(state).length, 0);
});

test("forbidden listing discovers and deduplicates hydrated history across pages", async () => {
  const second = task({ id: id(8), name: "Design" });
  const { api, state } = mockApi({ taskListStatus: 403, tasks: [task(), second], entries: [
    ...Array.from({ length: 200 }, (_, n) => entry({ id: id(100 + n) })),
    entry({ id: id(400), taskId: second.id }),
  ] });
  const discovery = new TaskDiscovery(api);
  const found = await discovery.list(W, U, P);
  assert.equal(found.source, "history");
  assert.equal(found.partial, true);
  assert.deepEqual(found.tasks.map(t => t.id), [T, second.id]);
  assert.equal(historyCalls(state).length, 2);
  for (const c of historyCalls(state)) {
    assert.equal(c.url.searchParams.get("project"), P);
    assert.equal(c.url.searchParams.get("hydrated"), "true");
  }
});

test("new tasks are rediscovered on miss, explicit refresh, and TTL expiry", async () => {
  let now = 0;
  const { api, state } = mockApi({ taskListStatus: 403, entries: [entry()] });
  const discovery = new TaskDiscovery(api, () => now);
  await discovery.list(W, U, P);
  await discovery.list(W, U, P);
  assert.equal(historyCalls(state).length, 1);
  const newTask = task({ id: id(8), name: "Newly created" });
  state.tasks.push(newTask);
  // An unused task cannot be discovered through history.
  await assert.rejects(discovery.resolve(W, U, P, newTask.name), /only tasks found in your own history/);
  state.entries.push(entry({ id: id(9), taskId: newTask.id }));
  assert.equal((await discovery.resolve(W, U, P, newTask.name)).id, newTask.id);
  const count = historyCalls(state).length;
  await discovery.list(W, U, P, true);
  assert.equal(historyCalls(state).length, count + 1);
  now += 300_001;
  await discovery.list(W, U, P);
  assert.equal(historyCalls(state).length, count + 2);
});

test("a newly created unused task is visible on refresh with normal permissions", async () => {
  const { api, state } = mockApi();
  const discovery = new TaskDiscovery(api);
  await discovery.list(W, U, P);
  state.tasks.push(task({ id: id(8), name: "Unused" }));
  assert.equal((await discovery.list(W, U, P, true)).tasks.length, 2);
});

test("cache scopes include user, workspace, project, and client credentials", async () => {
  const a = mockApi({ taskListStatus: 403, entries: [entry()] });
  const discovery = new TaskDiscovery(a.api);
  assert.equal((await discovery.list(W, U, P)).tasks.length, 1);
  assert.equal((await discovery.list(W, id(20), P)).tasks.length, 0);
  assert.equal((await discovery.list(id(21), U, P)).tasks.length, 0);
  a.state.projects.push({ id: id(22) });
  assert.equal((await discovery.list(W, U, id(22))).tasks.length, 0);
  const b = mockApi({ taskListStatus: 403 });
  assert.equal((await new TaskDiscovery(b.api).list(W, U, P)).tasks.length, 0);
});

test("history ignores entries outside the requested account and project even if the API filter fails", async () => {
  const { api } = mockApi({ taskListStatus: 403, intercept: c => {
    if (c.url.pathname.includes("/user/")) return response([
      entry({ userId: id(8), task: task() }), entry({ workspaceId: id(9), task: task() }),
      entry({ projectId: id(10), task: task() }),
    ]);
  } });
  assert.equal((await new TaskDiscovery(api).list(W, U, P)).tasks.length, 0);
});

test("history without embedded task metadata resolves known IDs directly", async () => {
  const { api } = mockApi({ taskListStatus: 403, hydrate: false, entries: [entry()] });
  const found = await new TaskDiscovery(api).list(W, U, P);
  assert.equal(found.tasks[0].name, "Development");
});

test("an explicit ID works before first use even if both task reads are forbidden", async () => {
  const { api, state } = mockApi({ taskListStatus: 403, taskDetailStatus: 403 });
  const found = await new TaskDiscovery(api).resolve(W, U, P, T);
  assert.equal(found.id, T);
  assert.equal(found.status, "UNKNOWN");
  assert.equal(historyCalls(state).length, 0);
});

test("cached tasks are checked for completion before use without choosing a substitute", async () => {
  const { api, state } = mockApi({ taskListStatus: 403, entries: [entry()] });
  const discovery = new TaskDiscovery(api);
  await discovery.list(W, U, P);
  state.tasks[0].status = "DONE";
  await assert.rejects(discovery.resolve(W, U, P, "Development"), /is DONE/);
  assert.equal((await discovery.list(W, U, P)).tasks[0].status, "DONE");
});

test("renamed tasks do not continue matching a cached old name", async () => {
  const { api, state } = mockApi();
  const discovery = new TaskDiscovery(api);
  await discovery.list(W, U, P);
  state.tasks[0].name = "Renamed";
  await assert.rejects(discovery.resolve(W, U, P, "Development"), /No task found/);
  assert.equal((await discovery.resolve(W, U, P, "Renamed")).id, T);
});

test("ambiguous names list candidates instead of selecting a billing code", async () => {
  const { api } = mockApi({ tasks: [task(), task({ id: id(8), name: "Development" })] });
  await assert.rejects(new TaskDiscovery(api).resolve(W, U, P, "Development"), err => {
    assert.equal(err.candidates.length, 2);
    return /Multiple tasks/.test(err.message);
  });
});

for (const status of [401, 429, 500]) test(`HTTP ${status} is not disguised as a task permission fallback`, async () => {
  const { api, state } = mockApi({ taskListStatus: status });
  await assert.rejects(new TaskDiscovery(api).list(W, U, P), err => err.status === status);
  assert.equal(historyCalls(state).length, 0);
});

test("task-detail authentication failure is not treated as permission to trust an ID", async () => {
  const { api } = mockApi({ taskDetailStatus: 401 });
  await assert.rejects(new TaskDiscovery(api).resolve(W, U, P, T), err => err.status === 401);
});

test("history scan is bounded and its truncation is disclosed", async () => {
  const { api, state } = mockApi({ taskListStatus: 403, intercept: c => {
    if (c.url.pathname.includes("/user/")) return response(Array.from({ length: 200 }, () => entry({ task: task() })));
  } });
  const catalog = await new TaskDiscovery(api).list(W, U, P);
  assert.equal(catalog.historyLimitReached, true);
  assert.equal(historyCalls(state).length, 10);
});

test("simultaneous catalog requests share one discovery", async () => {
  const { api, state } = mockApi({ taskListStatus: 403, entries: [entry()] });
  const discovery = new TaskDiscovery(api);
  await Promise.all([discovery.list(W, U, P), discovery.list(W, U, P)]);
  assert.equal(historyCalls(state).length, 1);
});
