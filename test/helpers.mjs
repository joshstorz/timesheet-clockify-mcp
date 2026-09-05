import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ClockifyClient } from "../dist/clockify.js";
import { createServer } from "../dist/index.js";

// Deliberately synthetic fixtures; never copy live account data into this repository.
export const id = n => n.toString(16).padStart(24, "0");
export const WORKSPACE = id(1), USER = id(2), PROJECT = id(3), TASK = id(4), ENTRY = id(5);
export const START = "2026-01-01T09:00:00Z", END = "2026-01-01T10:00:00Z";
export const project = (overrides = {}) => ({ id: PROJECT, name: "Example project", clientName: "Example client", billable: true, archived: false, ...overrides });
export const task = (overrides = {}) => ({ id: TASK, name: "Development", projectId: PROJECT, status: "ACTIVE", ...overrides });
export const entry = (overrides = {}) => ({
  id: ENTRY, workspaceId: WORKSPACE, userId: USER, projectId: PROJECT, taskId: TASK,
  description: "Example work", billable: true, tagIds: [id(6)],
  timeInterval: { start: START, end: null, duration: null }, ...overrides,
});
export const response = (body, status = 200) => new Response(JSON.stringify(body), { status });

export function mockApi(options = {}) {
  const state = {
    user: { id: USER, name: "Example user", email: "user@example.test", activeWorkspace: WORKSPACE },
    projects: [project()], tasks: [task()], entries: [], taskListStatus: 200,
    taskDetailStatus: 200, requiresTask: false, hydrate: true, calls: [], ...options,
  };
  const fetcher = async (url, init) => {
    const u = new URL(url), parts = u.pathname.split("/").filter(Boolean).slice(2);
    const method = init.method ?? "GET", body = init.body ? JSON.parse(init.body) : undefined;
    const call = { url: u, method, body };
    state.calls.push(call);
    const override = await state.intercept?.(call, state);
    if (override) return override;
    if (u.pathname === "/api/v1/user") return response(state.user);
    const [, workspaceId, resource, resourceId, child, childId] = parts;
    if (resource === "projects") {
      const p = state.projects.find(p => p.id === resourceId);
      if (!resourceId) return response(state.projects.filter(p => !u.searchParams.get("name") || p.name.toLowerCase().includes(u.searchParams.get("name").toLowerCase())));
      if (!p) return response({ message: "Project not found" }, 404);
      if (child !== "tasks") return response(p);
      if (!childId) {
        if (state.taskListStatus !== 200) return response({ message: "Access Denied", code: 501 }, state.taskListStatus);
        const tasks = state.tasks.filter(t => t.projectId === resourceId);
        const page = +(u.searchParams.get("page") ?? 1), size = +(u.searchParams.get("page-size") ?? 50);
        return response(tasks.slice((page - 1) * size, page * size));
      }
      if (state.taskDetailStatus !== 200) return response({ message: "Access Denied", code: 501 }, state.taskDetailStatus);
      const t = state.tasks.find(t => t.projectId === resourceId && t.id === childId);
      return t ? response(t) : response({ message: "Task not found" }, 404);
    }
    if (resource === "tags") return response([{ id: id(6), name: "Example tag", archived: false }]);
    if (resource === "user" && child === "time-entries" && method === "GET") {
      const items = state.entries.filter(e => e.workspaceId === workspaceId && e.userId === resourceId)
        .filter(e => !u.searchParams.has("project") || e.projectId === u.searchParams.get("project"))
        .filter(e => !u.searchParams.has("in-progress") || !e.timeInterval.end)
        .filter(e => !u.searchParams.has("start") || e.timeInterval.start >= u.searchParams.get("start"))
        .filter(e => !u.searchParams.has("end") || e.timeInterval.start <= u.searchParams.get("end"))
        .sort((a, b) => b.timeInterval.start.localeCompare(a.timeInterval.start));
      const page = +(u.searchParams.get("page") ?? 1), size = +(u.searchParams.get("page-size") ?? 50);
      return response(items.slice((page - 1) * size, page * size).map(e => {
        if (!state.hydrate || !u.searchParams.has("hydrated")) return e;
        return { ...e, project: state.projects.find(p => p.id === e.projectId) ?? null, task: state.tasks.find(t => t.id === e.taskId) ?? null };
      }));
    }
    if (resource === "time-entries") {
      const existing = state.entries.find(e => e.id === resourceId && e.workspaceId === workspaceId);
      if (method === "GET") return existing ? response(existing) : response({ message: "Entry not found" }, 404);
      if (method === "PUT" || method === "POST") {
        if (method === "PUT" && !existing) return response({ message: "Entry not found" }, 404);
        const selectedTask = state.tasks.find(t => t.id === body.taskId && t.projectId === body.projectId);
        if ((state.requiresTask && !body.taskId) || (body.taskId && (!selectedTask || selectedTask.status !== "ACTIVE"))) {
          return response({ code: 501, message: "Time entry couldn't be created. Task is either required field or given task is completed." }, 400);
        }
        const saved = {
          ...(existing ?? entry({ id: id(1000 + state.entries.length), userId: state.user.id, workspaceId })),
          ...body,
          customFieldValues: body.customFields ?? existing?.customFieldValues,
          timeInterval: { start: body.start, end: body.end ?? null, duration: body.end ? `PT${(Date.parse(body.end) - Date.parse(body.start)) / 1000}S` : null },
        };
        if (existing) state.entries[state.entries.indexOf(existing)] = saved;
        else state.entries.unshift(saved);
        return response(saved);
      }
    }
    throw new Error(`Unexpected mock request: ${method} ${u.pathname}`);
  };
  return { state, api: new ClockifyClient("synthetic-test-key", fetcher) };
}

export async function harness(t, options = {}, serverOptions = {}) {
  const { state, api } = mockApi(options);
  const server = createServer(api, serverOptions);
  const client = new Client({ name: "integration-test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  return { state, api, client, call: (name, args = {}) => client.callTool({ name, arguments: args }) };
}
export const text = result => result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
export const writes = state => state.calls.filter(c => ["PUT", "POST", "PATCH", "DELETE"].includes(c.method));
export const historyCalls = state => state.calls.filter(c => c.url.pathname.includes("/user/") && c.url.pathname.endsWith("/time-entries"));
