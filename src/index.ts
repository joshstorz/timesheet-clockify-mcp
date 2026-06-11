#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ClockifyClient,
  ClockifyError,
  Project,
  Tag,
  Task,
  TimeEntry,
  User,
} from "./clockify.js";
import {
  resolveProject,
  resolveTask,
  resolveTags,
} from "./resolver.js";
import {
  formatDuration,
  isoNow,
  parseDuration,
  summarizeEntry,
  toIso,
  durationBetween,
} from "./format.js";

const TOKEN = process.env.CLOCKIFY_API_TOKEN;
if (!TOKEN) {
  console.error(
    "[timesheet-clockify-mcp] Missing CLOCKIFY_API_TOKEN. Get one at clockify.me → profile settings → API."
  );
  process.exit(1);
}

const DEFAULT_PROJECT = process.env.CLOCKIFY_DEFAULT_PROJECT;
const WORKSPACE_OVERRIDE = process.env.CLOCKIFY_WORKSPACE_ID;
const DEFAULT_BILLABLE: boolean | undefined =
  process.env.CLOCKIFY_DEFAULT_BILLABLE === undefined
    ? undefined
    : ["true", "1", "yes"].includes(process.env.CLOCKIFY_DEFAULT_BILLABLE.toLowerCase());

const client = new ClockifyClient(TOKEN);

let cachedUser: User | null = null;
async function getContext(): Promise<{ user: User; workspaceId: string }> {
  if (!cachedUser) cachedUser = await client.getUser();
  const workspaceId = WORKSPACE_OVERRIDE || cachedUser.activeWorkspace || cachedUser.defaultWorkspace;
  return { user: cachedUser, workspaceId };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(err: unknown) {
  if (err instanceof ClockifyError) {
    const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
    return { content: [{ type: "text" as const, text: `Clockify error (${err.status ?? "?"}): ${err.message}\n${body}` }], isError: true };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

async function resolveProjectOrError(workspaceId: string, nameOrId: string): Promise<{ id: string; billable: boolean } | { error: string }> {
  const result = await resolveProject(client, workspaceId, nameOrId);
  if (result.match) return { id: result.match.id, billable: result.match.billable };
  if (result.candidates.length > 1) {
    const list = result.candidates.map((c) => `  • ${c.name} (id: ${c.id})`).join("\n");
    return { error: `Multiple projects match "${nameOrId}":\n${list}\nPass the exact name or the id.` };
  }
  return { error: `No project found matching "${nameOrId}".` };
}

async function buildLookupMaps(workspaceId: string, entries: TimeEntry[]) {
  const projectIds = new Set<string>();
  const taskIds = new Set<string>();
  const tagIds = new Set<string>();
  for (const e of entries) {
    if (e.projectId) projectIds.add(e.projectId);
    if (e.taskId) taskIds.add(e.taskId);
    for (const t of e.tagIds ?? []) tagIds.add(t);
  }
  const [projects, tags] = await Promise.all([
    projectIds.size ? client.listProjects(workspaceId, {}) : Promise.resolve<Project[]>([]),
    tagIds.size ? client.listTags(workspaceId, {}) : Promise.resolve<Tag[]>([]),
  ]);
  const projectsById = new Map(projects.map((p) => [p.id, p] as const));
  const tagsById = new Map(tags.map((t) => [t.id, t] as const));
  const tasksById = new Map<string, Task>();
  await Promise.all(
    [...taskIds].map(async (tid) => {
      const e = entries.find((e) => e.taskId === tid && e.projectId);
      if (!e?.projectId) return;
      try {
        const tasks = await client.listTasks(workspaceId, e.projectId, {});
        const match = tasks.find((t) => t.id === tid);
        if (match) tasksById.set(tid, match);
      } catch {}
    })
  );
  return { projectsById, tasksById, tagsById };
}

const server = new McpServer({
  name: "timesheet-clockify-mcp",
  version: "0.1.0",
});

// ---------- Identity ----------
server.tool(
  "me",
  "Get the current Clockify user, their email, and the active workspace id. Call this if you need the workspace id for other tools or to confirm which account is connected.",
  {},
  async () => {
    try {
      const { user, workspaceId } = await getContext();
      const defaultProj = DEFAULT_PROJECT ? `\nDefault project (from env): ${DEFAULT_PROJECT}` : "";
      return textResult(
        `User: ${user.name} <${user.email}>\nUser ID: ${user.id}\nWorkspace ID: ${workspaceId}${defaultProj}`
      );
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ---------- Lookups ----------
server.tool(
  "list-projects",
  "List projects in the active workspace. Optionally filter by name substring or include archived projects.",
  {
    name: z.string().optional().describe("Filter by name (substring match)"),
    includeArchived: z.boolean().optional().describe("Include archived projects (default false)"),
  },
  async ({ name, includeArchived }) => {
    try {
      const { workspaceId } = await getContext();
      const projects = await client.listProjects(workspaceId, {
        name,
        archived: includeArchived ? undefined : false,
      });
      if (!projects.length) return textResult("No projects found.");
      const lines = projects.map(
        (p) => `${p.name}${p.clientName ? ` (client: ${p.clientName})` : ""}${p.archived ? " [archived]" : ""} — id: ${p.id}`
      );
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "list-tasks",
  "List tasks under a specific project. Project can be passed as name or id.",
  {
    project: z.string().describe("Project name or id"),
    name: z.string().optional().describe("Filter tasks by name substring"),
  },
  async ({ project, name }) => {
    try {
      const { workspaceId } = await getContext();
      const resolved = await resolveProjectOrError(workspaceId, project);
      if ("error" in resolved) return textResult(resolved.error);
      const tasks = await client.listTasks(workspaceId, resolved.id, { name });
      if (!tasks.length) return textResult("No tasks found for that project.");
      return textResult(tasks.map((t) => `${t.name} — id: ${t.id} (${t.status})`).join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "list-tags",
  "List tags available in the workspace. Optionally filter by name substring.",
  {
    name: z.string().optional(),
    includeArchived: z.boolean().optional(),
  },
  async ({ name, includeArchived }) => {
    try {
      const { workspaceId } = await getContext();
      const tags = await client.listTags(workspaceId, {
        name,
        archived: includeArchived ? undefined : false,
      });
      if (!tags.length) return textResult("No tags found.");
      return textResult(tags.map((t) => `${t.name}${t.archived ? " [archived]" : ""} — id: ${t.id}`).join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "list-entries",
  "List recent time entries. Defaults to today. Pass start/end as ISO datetimes for a custom range. Set inProgress=true to only return the currently running timer (if any).",
  {
    start: z.string().optional().describe("Start of range, ISO 8601 (e.g. 2026-04-01T00:00:00Z). Defaults to start of today."),
    end: z.string().optional().describe("End of range, ISO 8601. Defaults to now."),
    inProgress: z.boolean().optional().describe("Only return the running timer"),
    limit: z.number().int().min(1).max(200).optional().describe("Max entries to return (default 50)"),
  },
  async ({ start, end, inProgress, limit }) => {
    try {
      const { user, workspaceId } = await getContext();
      const todayStart = new Date();
      todayStart.setUTCHours(0, 0, 0, 0);
      const entries = await client.listTimeEntries(workspaceId, user.id, {
        start: start ? toIso(start) : todayStart.toISOString().replace(/\.\d{3}Z$/, "Z"),
        end: end ? toIso(end) : undefined,
        inProgress: inProgress || undefined,
        pageSize: limit ?? 50,
      });
      if (!entries.length) return textResult("No entries in that range.");
      const maps = await buildLookupMaps(workspaceId, entries);
      const lines = entries.map((e) => `[${e.id}] ${summarizeEntry(e, maps.projectsById, maps.tasksById, maps.tagsById)}`);
      return textResult(lines.join("\n"));
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ---------- Timer ----------
server.tool(
  "current-timer",
  "Show the currently running timer (if any), with elapsed time, project, and description.",
  {},
  async () => {
    try {
      const { user, workspaceId } = await getContext();
      const entries = await client.listTimeEntries(workspaceId, user.id, { inProgress: true, pageSize: 1 });
      if (!entries.length) return textResult("No timer running.");
      const entry = entries[0];
      const maps = await buildLookupMaps(workspaceId, entries);
      const elapsed = formatDuration(durationBetween(entry.timeInterval.start, isoNow()));
      const summary = summarizeEntry(entry, maps.projectsById, maps.tasksById, maps.tagsById);
      return textResult(`Running for ${elapsed}\n${summary}\nEntry id: ${entry.id}`);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "start-timer",
  "Start a new running timer. If project is omitted and CLOCKIFY_DEFAULT_PROJECT is set in the environment, that project is used.",
  {
    description: z.string().optional().describe("What you're working on"),
    project: z.string().optional().describe("Project name or id"),
    task: z.string().optional().describe("Task name or id (requires project)"),
    tags: z.array(z.string()).optional().describe("Tag names or ids"),
    billable: z.boolean().optional().describe("Whether the time is billable. If omitted, falls back to CLOCKIFY_DEFAULT_BILLABLE, then the project's billable setting, then false."),
  },
  async ({ description, project, task, tags, billable }) => {
    try {
      const { workspaceId } = await getContext();
      const input: Record<string, unknown> = {
        start: isoNow(),
        description: description ?? "",
      };
      let projectBillable: boolean | undefined;
      const projectInput = project ?? DEFAULT_PROJECT;
      if (projectInput) {
        const resolved = await resolveProjectOrError(workspaceId, projectInput);
        if ("error" in resolved) return textResult(resolved.error);
        input.projectId = resolved.id;
        projectBillable = resolved.billable;
        if (task) {
          const taskResult = await resolveTask(client, workspaceId, resolved.id, task);
          if (!taskResult.match) {
            if (taskResult.candidates.length > 1) {
              const list = taskResult.candidates.map((t) => `  • ${t.name} (id: ${t.id})`).join("\n");
              return textResult(`Multiple tasks match "${task}":\n${list}`);
            }
            return textResult(`No task found matching "${task}".`);
          }
          input.taskId = taskResult.match.id;
        }
      } else if (task) {
        return textResult("Cannot set a task without a project.");
      }
      if (tags?.length) {
        const tagResult = await resolveTags(client, workspaceId, tags);
        if (tagResult.unresolved.length || tagResult.ambiguous.length) {
          const unresolved = tagResult.unresolved.length
            ? `\nUnknown tags: ${tagResult.unresolved.join(", ")}`
            : "";
          const ambiguous = tagResult.ambiguous.length
            ? "\nAmbiguous tags:\n" + tagResult.ambiguous.map((a) => `  ${a.input} → ${a.matches.map((m) => m.name).join(", ")}`).join("\n")
            : "";
          return textResult(`Tag resolution failed.${unresolved}${ambiguous}`);
        }
        input.tagIds = tagResult.ids;
      }
      const effectiveBillable = billable ?? DEFAULT_BILLABLE ?? projectBillable;
      if (effectiveBillable !== undefined) input.billable = effectiveBillable;
      const entry = await client.createTimeEntry(workspaceId, input as unknown as Parameters<typeof client.createTimeEntry>[1]);
      const maps = await buildLookupMaps(workspaceId, [entry]);
      return textResult(`Started timer.\n${summarizeEntry(entry, maps.projectsById, maps.tasksById, maps.tagsById)}\nEntry id: ${entry.id}`);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "stop-timer",
  "Stop the currently running timer. Returns the project, description, and total duration so you can confirm or correct.",
  {},
  async () => {
    try {
      const { user, workspaceId } = await getContext();
      const stopped = await client.stopCurrentTimer(workspaceId, user.id, isoNow());
      if (!stopped) return textResult("No timer was running.");
      const maps = await buildLookupMaps(workspaceId, [stopped]);
      return textResult(`Stopped.\n${summarizeEntry(stopped, maps.projectsById, maps.tasksById, maps.tagsById)}\nEntry id: ${stopped.id}`);
    } catch (err) {
      if (err instanceof ClockifyError && err.status === 404) {
        return textResult("No timer was running.");
      }
      return errorResult(err);
    }
  }
);

server.tool(
  "log-past-entry",
  "Log time you forgot to track. Start and end are required, both as ISO 8601 datetimes.",
  {
    start: z.string().describe("Start datetime, ISO 8601 (e.g. 2026-05-10T09:00:00Z)"),
    end: z.string().describe("End datetime, ISO 8601"),
    description: z.string().optional(),
    project: z.string().optional(),
    task: z.string().optional(),
    tags: z.array(z.string()).optional(),
    billable: z.boolean().optional().describe("Whether the time is billable. If omitted, falls back to CLOCKIFY_DEFAULT_BILLABLE, then the project's billable setting, then false."),
  },
  async ({ start, end, description, project, task, tags, billable }) => {
    try {
      const { workspaceId } = await getContext();
      const startIso = toIso(start);
      const endIso = toIso(end);
      const input: Record<string, unknown> = {
        start: startIso,
        end: endIso,
        description: description ?? "",
      };
      let projectBillable: boolean | undefined;
      const projectInput = project ?? DEFAULT_PROJECT;
      if (projectInput) {
        const resolved = await resolveProjectOrError(workspaceId, projectInput);
        if ("error" in resolved) return textResult(resolved.error);
        input.projectId = resolved.id;
        projectBillable = resolved.billable;
        if (task) {
          const taskResult = await resolveTask(client, workspaceId, resolved.id, task);
          if (!taskResult.match) return textResult(`No task found matching "${task}".`);
          input.taskId = taskResult.match.id;
        }
      }
      if (tags?.length) {
        const tagResult = await resolveTags(client, workspaceId, tags);
        if (tagResult.unresolved.length || tagResult.ambiguous.length) {
          return textResult(`Tag resolution failed. Unknown: ${tagResult.unresolved.join(", ")}. Ambiguous: ${tagResult.ambiguous.map((a) => a.input).join(", ")}`);
        }
        input.tagIds = tagResult.ids;
      }
      const effectiveBillable = billable ?? DEFAULT_BILLABLE ?? projectBillable;
      if (effectiveBillable !== undefined) input.billable = effectiveBillable;
      const entry = await client.createTimeEntry(workspaceId, input as unknown as Parameters<typeof client.createTimeEntry>[1]);
      const maps = await buildLookupMaps(workspaceId, [entry]);
      return textResult(`Logged.\n${summarizeEntry(entry, maps.projectsById, maps.tasksById, maps.tagsById)}\nEntry id: ${entry.id}`);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "edit-entry",
  "Edit an existing time entry. Only pass the fields you want to change. The entry's start time is preserved if you don't pass a new one.",
  {
    entryId: z.string().describe("Entry id (looks like a 24-char hex string)"),
    start: z.string().optional(),
    end: z.string().optional(),
    description: z.string().optional(),
    project: z.string().optional(),
    task: z.string().optional(),
    tags: z.array(z.string()).optional(),
    billable: z.boolean().optional(),
  },
  async ({ entryId, start, end, description, project, task, tags, billable }) => {
    try {
      const { workspaceId } = await getContext();
      const existing = await client.getTimeEntry(workspaceId, entryId);
      const input: Record<string, unknown> = {
        start: start ? toIso(start) : existing.timeInterval.start,
      };
      if (end !== undefined) input.end = toIso(end);
      else if (existing.timeInterval.end) input.end = existing.timeInterval.end;
      input.description = description !== undefined ? description : existing.description;
      let projectId = existing.projectId ?? undefined;
      if (project !== undefined) {
        const resolved = await resolveProjectOrError(workspaceId, project);
        if ("error" in resolved) return textResult(resolved.error);
        projectId = resolved.id;
      }
      if (projectId) input.projectId = projectId;
      if (task !== undefined && projectId) {
        const taskResult = await resolveTask(client, workspaceId, projectId, task);
        if (!taskResult.match) return textResult(`No task found matching "${task}".`);
        input.taskId = taskResult.match.id;
      } else if (existing.taskId) {
        input.taskId = existing.taskId;
      }
      if (tags !== undefined) {
        const tagResult = await resolveTags(client, workspaceId, tags);
        if (tagResult.unresolved.length || tagResult.ambiguous.length) {
          return textResult(`Tag resolution failed. Unknown: ${tagResult.unresolved.join(", ")}. Ambiguous: ${tagResult.ambiguous.map((a) => a.input).join(", ")}`);
        }
        input.tagIds = tagResult.ids;
      } else {
        input.tagIds = existing.tagIds ?? [];
      }
      input.billable = billable !== undefined ? billable : existing.billable;
      const updated = await client.updateTimeEntry(workspaceId, entryId, input as unknown as Parameters<typeof client.updateTimeEntry>[2]);
      const maps = await buildLookupMaps(workspaceId, [updated]);
      return textResult(`Updated.\n${summarizeEntry(updated, maps.projectsById, maps.tasksById, maps.tagsById)}`);
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "delete-entry",
  "Delete a time entry permanently.",
  {
    entryId: z.string().describe("Entry id"),
  },
  async ({ entryId }) => {
    try {
      const { workspaceId } = await getContext();
      await client.deleteTimeEntry(workspaceId, entryId);
      return textResult(`Deleted entry ${entryId}.`);
    } catch (err) {
      return errorResult(err);
    }
  }
);

// ---------- Reports ----------
server.tool(
  "summary-report",
  "Aggregate report. Returns totals (hours + billable amount) for a date range, grouped by project, client, tag, task, user, or date. Use this for 'how did I spend April' or 'what should I bill this month'.",
  {
    start: z.string().describe("Start of range, ISO 8601 or YYYY-MM-DD"),
    end: z.string().describe("End of range, ISO 8601 or YYYY-MM-DD"),
    groupBy: z.enum(["PROJECT", "CLIENT", "TAG", "TASK", "USER", "DATE"]).describe("How to group the results"),
    billableOnly: z.boolean().optional().describe("Only include billable time"),
    project: z.string().optional().describe("Limit to a single project (name or id)"),
  },
  async ({ start, end, groupBy, billableOnly, project }) => {
    try {
      const { workspaceId } = await getContext();
      const projectIds: string[] = [];
      if (project) {
        const resolved = await resolveProjectOrError(workspaceId, project);
        if ("error" in resolved) return textResult(resolved.error);
        projectIds.push(resolved.id);
      }
      const result = await client.summaryReport(workspaceId, {
        dateRangeStart: toIso(start),
        dateRangeEnd: toIso(end),
        groupBy,
        billable: billableOnly,
        projectIds: projectIds.length ? projectIds : undefined,
      });
      return textResult(JSON.stringify(result, null, 2));
    } catch (err) {
      return errorResult(err);
    }
  }
);

server.tool(
  "detailed-report",
  "Per-entry report. Returns every individual time entry in a range with computed durations and billable amounts. Use this for 'what specifically did I bill client X for in April'.",
  {
    start: z.string().describe("Start of range, ISO 8601 or YYYY-MM-DD"),
    end: z.string().describe("End of range, ISO 8601 or YYYY-MM-DD"),
    billableOnly: z.boolean().optional(),
    project: z.string().optional(),
    page: z.number().int().min(1).optional(),
    pageSize: z.number().int().min(1).max(200).optional(),
  },
  async ({ start, end, billableOnly, project, page, pageSize }) => {
    try {
      const { workspaceId } = await getContext();
      const projectIds: string[] = [];
      if (project) {
        const resolved = await resolveProjectOrError(workspaceId, project);
        if ("error" in resolved) return textResult(resolved.error);
        projectIds.push(resolved.id);
      }
      const result = await client.detailedReport(workspaceId, {
        dateRangeStart: toIso(start),
        dateRangeEnd: toIso(end),
        billable: billableOnly,
        projectIds: projectIds.length ? projectIds : undefined,
        page,
        pageSize,
      });
      return textResult(JSON.stringify(result, null, 2));
    } catch (err) {
      return errorResult(err);
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
