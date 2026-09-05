import { ClockifyClient, ClockifyError, Task } from "./clockify.js";
import { looksLikeId, pickByName } from "./resolver.js";

const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 256;
const HISTORY_PAGE_SIZE = 200;
const MAX_HISTORY_PAGES = 10;

export interface TaskCatalog {
  tasks: Task[];
  source: "project" | "history";
  partial: boolean;
  historyLimitReached: boolean;
  fetchedAt: number;
}

export class TaskResolutionError extends Error {
  constructor(message: string, public projectId: string, public candidates: Task[] = []) {
    super(message);
    this.name = "TaskResolutionError";
  }
}

/** An instance belongs to one API client. Nothing is persisted or shared between accounts. */
export class TaskDiscovery {
  private cache = new Map<string, TaskCatalog>();
  private pending = new Map<string, Promise<TaskCatalog>>();

  constructor(private client: ClockifyClient, private now: () => number = Date.now) {}

  private key(workspaceId: string, userId: string, projectId: string) {
    return JSON.stringify([workspaceId, userId, projectId]);
  }

  invalidate(workspaceId: string, userId: string, projectId: string) {
    const key = this.key(workspaceId, userId, projectId);
    this.cache.delete(key);
    // An older in-flight discovery must not repopulate an invalidated cache.
    this.pending.delete(key);
  }

  async list(workspaceId: string, userId: string, projectId: string, refresh = false): Promise<TaskCatalog> {
    const key = this.key(workspaceId, userId, projectId);
    const cached = this.cache.get(key);
    if (!refresh && cached && this.now() - cached.fetchedAt < CACHE_TTL_MS) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }
    const pending = this.pending.get(key);
    if (pending) return pending;
    const request = this.discover(workspaceId, userId, projectId);
    this.pending.set(key, request);
    try {
      const catalog = await request;
      if (this.pending.get(key) === request) {
        this.cache.delete(key);
        this.cache.set(key, catalog);
        if (this.cache.size > MAX_CACHE_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
      }
      return catalog;
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  private async discover(workspaceId: string, userId: string, projectId: string): Promise<TaskCatalog> {
    try {
      const tasks = await this.client.listTasks(workspaceId, projectId);
      return { tasks, source: "project", partial: false, historyLimitReached: false, fetchedAt: this.now() };
    } catch (err) {
      // Authentication, rate limits, and outages must retain their real errors.
      if (!(err instanceof ClockifyError && err.status === 403)) throw err;
    }

    const tasks = new Map<string, Task>();
    let historyLimitReached = false;
    for (let page = 1; page <= MAX_HISTORY_PAGES; page++) {
      const entries = await this.client.listTimeEntries(workspaceId, userId, {
        project: projectId, hydrated: true, page, pageSize: HISTORY_PAGE_SIZE,
      });
      for (const entry of entries) {
        // Even if an upstream filter changes, never borrow a billing code from another scope.
        if (entry.workspaceId !== workspaceId || entry.userId !== userId || entry.projectId !== projectId) continue;
        if (!entry.taskId || tasks.has(entry.taskId)) continue;
        const embedded = entry.task;
        let task: Task = embedded?.id === entry.taskId && embedded.projectId === projectId
          ? embedded
          : { id: entry.taskId, name: entry.taskId, projectId, status: "UNKNOWN" };
        if (task.status === "UNKNOWN") {
          try {
            task = await this.client.getTask(workspaceId, projectId, entry.taskId);
          } catch (err) {
            if (!(err instanceof ClockifyError && [400, 403, 404].includes(err.status ?? 0))) throw err;
            if (err.status !== 403) continue;
          }
        }
        if (task.projectId === projectId && task.id === entry.taskId) tasks.set(task.id, task);
      }
      if (entries.length < HISTORY_PAGE_SIZE) break;
      if (page === MAX_HISTORY_PAGES) historyLimitReached = true;
    }
    return { tasks: [...tasks.values()], source: "history", partial: true, historyLimitReached, fetchedAt: this.now() };
  }

  async resolve(workspaceId: string, userId: string, projectId: string, query: string): Promise<Task> {
    if (!query.trim()) throw new TaskResolutionError("Task name or id cannot be empty.", projectId);
    if (looksLikeId(query)) return this.validate(workspaceId, userId, projectId, query);

    const key = this.key(workspaceId, userId, projectId);
    const previous = this.cache.get(key);
    let catalog = await this.list(workspaceId, userId, projectId);
    let result = pickByName(catalog.tasks, query);
    // A new task can be discovered immediately without waiting for cache expiry.
    if (!result.match && result.candidates.length === 0 && catalog === previous) {
      catalog = await this.list(workspaceId, userId, projectId, true);
      result = pickByName(catalog.tasks, query);
    }
    if (result.match) {
      const task = await this.validate(workspaceId, userId, projectId, result.match.id, result.match);
      if (pickByName([task], query).match) return task;
      // It was renamed since discovery. Refresh once, without silently using the old name.
      catalog = await this.list(workspaceId, userId, projectId, true);
      result = pickByName(catalog.tasks, query);
      if (result.match) return this.validate(workspaceId, userId, projectId, result.match.id, result.match);
    }
    const candidates = result.candidates.length ? result.candidates : catalog.tasks.filter(t => t.status === "ACTIVE");
    const message = result.candidates.length > 1
      ? `Multiple tasks match "${query}". Pass an exact name or task id.`
      : `No task found matching "${query}".${catalog.partial ? " Task listing is forbidden; only tasks found in your own history are discoverable. Use the task in Clockify first, then call list-tasks with refresh=true, or pass its id directly." : " Call list-tasks with refresh=true to check for new tasks."}`;
    throw new TaskResolutionError(message, projectId, candidates);
  }

  private async validate(workspaceId: string, userId: string, projectId: string, taskId: string, known?: Task): Promise<Task> {
    let task: Task;
    try {
      task = await this.client.getTask(workspaceId, projectId, taskId);
    } catch (err) {
      if (!(err instanceof ClockifyError)) throw err;
      if (err.status === 403) {
        // An explicit or discovered ID may still be writable. Clockify validates the write.
        task = known ?? { id: taskId, name: taskId, projectId, status: "UNKNOWN" };
      } else if (err.status === 400 || err.status === 404) {
        this.invalidate(workspaceId, userId, projectId);
        throw new TaskResolutionError(`Task ${taskId} was not found in this project. Refresh list-tasks or supply another task id.`, projectId);
      } else throw err;
    }
    if (task.id !== taskId || task.projectId !== projectId) {
      throw new TaskResolutionError(`Task ${taskId} does not belong to this project.`, projectId);
    }
    if (task.status !== "ACTIVE" && task.status !== "UNKNOWN") {
      this.invalidate(workspaceId, userId, projectId);
      throw new TaskResolutionError(`Task "${task.name}" (${task.id}) is ${task.status}. Choose an active task with list-tasks; no replacement was selected.`, projectId);
    }
    return task;
  }
}
