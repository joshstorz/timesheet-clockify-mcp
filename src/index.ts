#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { readFileSync, realpathSync } from "node:fs";
import { z } from "zod";
import {
  ClockifyClient,
  ClockifyError,
  Project,
  Tag,
  Task,
  TimeEntry,
  User,
  CreateEntryInput,
} from "./clockify.js";
import {
  resolveProject,
  resolveTags,
} from "./resolver.js";
import {
  formatDuration,
  isoNow,
  summarizeEntry,
  toIso,
  durationBetween,
} from "./format.js";
import { TaskDiscovery, TaskResolutionError } from "./tasks.js";
import { EntryWriteContext, isTaskValidationError, preserveEntry, TaskRequiredError, validateInterval } from "./entries.js";

export interface ServerOptions {
  defaultProject?: string;
  workspaceId?: string;
  defaultBillable?: boolean;
}

export function createServer(client: ClockifyClient, options: ServerOptions = {}) {
  const { defaultProject: DEFAULT_PROJECT, workspaceId: WORKSPACE_OVERRIDE, defaultBillable: DEFAULT_BILLABLE } = options;
  const taskDiscovery = new TaskDiscovery(client);

  let cachedUser: User | null = null;
  let userFetchedAt = 0;
  async function getContext(): Promise<{ user: User; workspaceId: string }> {
    if (!cachedUser || Date.now() - userFetchedAt >= 60_000) {
      cachedUser = await client.getUser();
      userFetchedAt = Date.now();
    }
    const workspaceId = WORKSPACE_OVERRIDE || cachedUser.activeWorkspace || cachedUser.defaultWorkspace;
    return { user: cachedUser, workspaceId };
  }

  function textResult(text: string) {
    return { content: [{ type: "text" as const, text }] };
  }

  async function errorResult(err: unknown) {
    if (err instanceof TaskRequiredError) {
      const c = err.context;
      let availableTasks: Task[] = [];
      let discovery: Record<string, unknown> | null = null;
      let projectName: string | null = null;
      if (c.projectId) {
        const [project, catalog] = await Promise.allSettled([
          client.getProject(c.workspaceId, c.projectId),
          taskDiscovery.list(c.workspaceId, c.userId, c.projectId, true),
        ]);
        if (project.status === "fulfilled") projectName = project.value.name;
        if (catalog.status === "fulfilled") {
          availableTasks = catalog.value.tasks.filter(t => t.status === "ACTIVE");
          discovery = { source: catalog.value.source, partial: catalog.value.partial, historyLimitReached: catalog.value.historyLimitReached };
        } else discovery = { error: catalog.reason instanceof Error ? catalog.reason.message : String(catalog.reason) };
      }
      const details = {
        error: "TASK_REQUIRED_OR_COMPLETED",
        operation: c.operation,
        workspaceId: c.workspaceId,
        entryId: c.entryId ?? null,
        projectId: c.projectId ?? null,
        projectName,
        existingTaskId: c.existingTaskId ?? null,
        attemptedTaskId: c.attemptedTaskId ?? null,
        requestedEnd: c.requestedEnd ?? null,
        availableTasks: availableTasks.map(({ id, name, status }) => ({ id, name, status })),
        discovery,
        recovery: `Retry ${c.operation} with the same arguments and task="<active task name or id for this project>". Use list-tasks(project, refresh=true) to rediscover tasks. If task listing is forbidden, first use a new task in Clockify or supply its id directly.`,
      };
      return { ...textResult(`${err.message}\nClockify rejected this write; no automatic retry was made.\n${JSON.stringify(details, null, 2)}`), structuredContent: details, isError: true };
    }
    if (err instanceof TaskResolutionError) {
      const details = { error: "TASK_RESOLUTION_FAILED", projectId: err.projectId, candidates: err.candidates };
      return { ...textResult(`${err.message}\n${err.candidates.map(t => `${t.name} — id: ${t.id} (${t.status})`).join("\n")}`), structuredContent: details, isError: true };
    }
    if (err instanceof ClockifyError) {
      const body = typeof err.body === "string" ? err.body : JSON.stringify(err.body);
      return { content: [{ type: "text" as const, text: `Clockify error (${err.status ?? "?"}): ${err.message}\n${body}` }], isError: true };
    }
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text" as const, text: message }], isError: true };
  }

  async function writeEntry(context: EntryWriteContext, write: () => Promise<TimeEntry>) {
    try {
      const entry = await write();
      if (context.projectId) taskDiscovery.invalidate(context.workspaceId, context.userId, context.projectId);
      return entry;
    } catch (err) {
      if (isTaskValidationError(err)) {
        if (context.projectId) taskDiscovery.invalidate(context.workspaceId, context.userId, context.projectId);
        throw new TaskRequiredError(context);
      }
      throw err;
    }
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
    const projectsById = new Map<string, Project>();
    const tagsById = new Map<string, Tag>();
    const tasksById = new Map<string, Task>();
    const taskLookupErrors = new Map<string, string>();
    for (const entry of entries) {
      if (entry.project?.id === entry.projectId) projectsById.set(entry.project.id, entry.project);
      if (entry.task?.id === entry.taskId) tasksById.set(entry.task.id, entry.task);
      for (const tag of entry.tags ?? []) tagsById.set(tag.id, tag);
    }
    // Labels are best effort. A successful write must never be reported as failed
    // just because a subsequent name lookup was forbidden or temporarily unavailable.
    await Promise.all([
      ...[...projectIds].filter(id => !projectsById.has(id)).map(async id => {
        try { projectsById.set(id, await client.getProject(workspaceId, id)); } catch {}
      }),
      (async () => {
        if (![...tagIds].some(id => !tagsById.has(id))) return;
        try {
          for (const tag of await client.listTags(workspaceId)) tagsById.set(tag.id, tag);
        } catch {}
      })(),
      ...[...taskIds].filter(id => !tasksById.has(id)).map(async (tid) => {
        const e = entries.find((e) => e.taskId === tid && e.projectId);
        if (!e?.projectId) return;
        try {
          tasksById.set(tid, await client.getTask(workspaceId, e.projectId, tid));
        } catch (err) {
          taskLookupErrors.set(tid, err instanceof ClockifyError && err.status === 403 ? "name lookup forbidden" : "name lookup unavailable");
        }
      }),
    ]);
    return { projectsById, tasksById, tagsById, taskLookupErrors };
  }

  const server = new McpServer({
    name: "timesheet-clockify-mcp",
    version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
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
    "List tasks under a project. If task listing is forbidden, discover task IDs/names from your own time-entry history. Results are cached for five minutes; refresh=true forces rediscovery. History cannot reveal tasks you have never used.",
    {
      project: z.string().describe("Project name or id"),
      name: z.string().optional().describe("Filter tasks by name substring"),
      refresh: z.boolean().optional().describe("Bypass the task cache and rediscover tasks, including newly used tasks"),
    },
    async ({ project, name, refresh }) => {
      try {
        const { user, workspaceId } = await getContext();
        const resolved = await resolveProjectOrError(workspaceId, project);
        if ("error" in resolved) return textResult(resolved.error);
        let catalog = await taskDiscovery.list(workspaceId, user.id, resolved.id, refresh);
        let tasks = catalog.tasks.filter(t => !name || t.name.toLowerCase().includes(name.toLowerCase()));
        if (name && !tasks.length && !refresh) {
          catalog = await taskDiscovery.list(workspaceId, user.id, resolved.id, true);
          tasks = catalog.tasks.filter(t => t.name.toLowerCase().includes(name.toLowerCase()));
        }
        const note = catalog.partial
          ? "Discovered from your own history because task listing is forbidden. This is a partial catalog; unused tasks require an explicit id or a time entry in Clockify first."
          : "Tasks from the project catalog.";
        const limitNote = catalog.historyLimitReached ? " History scan reached its limit of 2,000 entries for this project." : "";
        return {
          ...textResult(`${note}${limitNote}\n${tasks.length ? tasks.map(t => `${t.name} — id: ${t.id} (${t.status})`).join("\n") : "No tasks found for that project/filter."}`),
          structuredContent: { tasks, source: catalog.source, partial: catalog.partial, historyLimitReached: catalog.historyLimitReached, cachedAt: new Date(catalog.fetchedAt).toISOString(), cacheTtlSeconds: 300 },
        };
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
          start: start ? toIso(start) : inProgress ? undefined : todayStart.toISOString().replace(/\.\d{3}Z$/, "Z"),
          end: end ? toIso(end) : undefined,
          inProgress: inProgress || undefined,
          pageSize: limit ?? 50,
          hydrated: true,
        });
        if (!entries.length) return textResult("No entries in that range.");
        const maps = await buildLookupMaps(workspaceId, entries);
        const lines = entries.map((e) => `[${e.id}] ${summarizeEntry(e, maps.projectsById, maps.tasksById, maps.tagsById, maps.taskLookupErrors)}`);
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
        const entries = await client.listTimeEntries(workspaceId, user.id, { inProgress: true, pageSize: 1, hydrated: true });
        if (!entries.length) return textResult("No timer running.");
        const entry = entries[0];
        const maps = await buildLookupMaps(workspaceId, entries);
        const elapsed = formatDuration(durationBetween(entry.timeInterval.start, isoNow()));
        const summary = summarizeEntry(entry, maps.projectsById, maps.tasksById, maps.tagsById, maps.taskLookupErrors);
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
        const { user, workspaceId } = await getContext();
        const input: CreateEntryInput = {
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
          if (task !== undefined) {
            input.taskId = (await taskDiscovery.resolve(workspaceId, user.id, resolved.id, task)).id;
          }
        } else if (task !== undefined) {
          throw new Error("Cannot set a task without a project.");
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
        const entry = await writeEntry({
          operation: "start-timer", workspaceId, userId: user.id,
          projectId: input.projectId, attemptedTaskId: input.taskId,
        }, () => client.createTimeEntry(workspaceId, input));
        const maps = await buildLookupMaps(workspaceId, [entry]);
        return textResult(`Started timer.\n${summarizeEntry(entry, maps.projectsById, maps.tasksById, maps.tagsById, maps.taskLookupErrors)}\nEntry id: ${entry.id}`);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.tool(
    "stop-timer",
    "Stop the currently running timer. Returns the project, description, and total duration so you can confirm or correct. " +
      "Pass `task` (a name or id) to supply or replace a required task. Task names can be discovered from your history. " +
      "`end` lets you close it at a specific historical time " +
      "instead of right now (e.g. to fix a timer that was left running too long).",
    {
      task: z.string().optional().describe("Active task name or id to attach or replace on the running entry"),
      end: z.string().optional().describe("ISO 8601 datetime to stop at, instead of now"),
    },
    async ({ task, end }) => {
      try {
        const { user, workspaceId } = await getContext();
        const endIso = end ? toIso(end) : isoNow();

        const running = await client.listTimeEntries(workspaceId, user.id, { inProgress: true, pageSize: 1 });
        if (!running.length) return textResult("No timer was running.");
        const entry = await client.getTimeEntry(workspaceId, running[0].id);
        if (entry.timeInterval.end) return textResult("That timer was already stopped. No entry was changed.");
        if (entry.userId !== user.id) throw new Error("The running entry does not belong to the connected user.");
        validateInterval(entry.timeInterval.start, endIso);
        const input = preserveEntry(entry);
        input.end = endIso;
        if (task !== undefined) {
          if (!entry.projectId) throw new Error("Cannot set a task without a project.");
          input.taskId = (await taskDiscovery.resolve(workspaceId, user.id, entry.projectId, task)).id;
        }
        // Address the entry we read, not whichever timer happens to be current at write time.
        const stopped = await writeEntry({
          operation: "stop-timer", workspaceId, userId: user.id, entryId: entry.id,
          projectId: entry.projectId, existingTaskId: entry.taskId,
          attemptedTaskId: input.taskId, requestedEnd: endIso,
        }, () => client.updateTimeEntry(workspaceId, entry.id, input));
        const maps = await buildLookupMaps(workspaceId, [stopped]);
        return textResult(`Stopped.\n${summarizeEntry(stopped, maps.projectsById, maps.tasksById, maps.tagsById, maps.taskLookupErrors)}\nEntry id: ${stopped.id}`);
      } catch (err) {
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
        const { user, workspaceId } = await getContext();
        const startIso = toIso(start);
        const endIso = toIso(end);
        validateInterval(startIso, endIso);
        const input: CreateEntryInput = {
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
          if (task !== undefined) {
            input.taskId = (await taskDiscovery.resolve(workspaceId, user.id, resolved.id, task)).id;
          }
        } else if (task !== undefined) {
          throw new Error("Cannot set a task without a project.");
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
        const entry = await writeEntry({
          operation: "log-past-entry", workspaceId, userId: user.id,
          projectId: input.projectId, attemptedTaskId: input.taskId, requestedEnd: endIso,
        }, () => client.createTimeEntry(workspaceId, input));
        const maps = await buildLookupMaps(workspaceId, [entry]);
        return textResult(`Logged.\n${summarizeEntry(entry, maps.projectsById, maps.tasksById, maps.tagsById, maps.taskLookupErrors)}\nEntry id: ${entry.id}`);
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
        const { user, workspaceId } = await getContext();
        const existing = await client.getTimeEntry(workspaceId, entryId);
        const input = preserveEntry(existing);
        if (start !== undefined) input.start = toIso(start);
        if (end !== undefined) input.end = toIso(end);
        validateInterval(input.start, input.end);
        input.description = description !== undefined ? description : existing.description;
        let projectId = existing.projectId ?? undefined;
        if (project !== undefined) {
          const resolved = await resolveProjectOrError(workspaceId, project);
          if ("error" in resolved) return textResult(resolved.error);
          projectId = resolved.id;
          // Tasks belong to a project. Do not carry an old project's billing code across.
          if (projectId !== existing.projectId) input.taskId = null;
        }
        if (projectId) input.projectId = projectId;
        if (task !== undefined) {
          if (!projectId) throw new Error("Cannot set a task without a project.");
          input.taskId = (await taskDiscovery.resolve(workspaceId, user.id, projectId, task)).id;
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
        const updated = await writeEntry({
          operation: "edit-entry", workspaceId, userId: user.id, entryId,
          projectId, existingTaskId: existing.taskId, attemptedTaskId: input.taskId, requestedEnd: input.end,
        }, () => client.updateTimeEntry(workspaceId, entryId, input));
        const maps = await buildLookupMaps(workspaceId, [updated]);
        return textResult(`Updated.\n${summarizeEntry(updated, maps.projectsById, maps.tasksById, maps.tagsById, maps.taskLookupErrors)}`);
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

  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const token = process.env.CLOCKIFY_API_TOKEN;
  if (!token) {
    console.error("[timesheet-clockify-mcp] Missing CLOCKIFY_API_TOKEN. Get one at clockify.me → profile settings → API.");
    process.exit(1);
  }
  const server = createServer(new ClockifyClient(token), {
    defaultProject: process.env.CLOCKIFY_DEFAULT_PROJECT,
    workspaceId: process.env.CLOCKIFY_WORKSPACE_ID,
    defaultBillable: process.env.CLOCKIFY_DEFAULT_BILLABLE === undefined
      ? undefined
      : ["true", "1", "yes"].includes(process.env.CLOCKIFY_DEFAULT_BILLABLE.toLowerCase()),
  });
  await server.connect(new StdioServerTransport());
}
