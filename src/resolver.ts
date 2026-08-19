import { ClockifyClient, ClockifyError, Project, Task, Tag } from "./clockify.js";

const ID_RE = /^[a-f0-9]{24}$/i;

export function looksLikeId(value: string): boolean {
  return ID_RE.test(value);
}

export interface ResolveResult<T> {
  match: T | null;
  candidates: T[];
  /** Set when the lookup could not be completed, rather than simply finding nothing. */
  error?: string;
}

export async function resolveProject(
  client: ClockifyClient,
  workspaceId: string,
  nameOrId: string
): Promise<ResolveResult<Project>> {
  // An id is fetched directly. Scanning the project list instead would miss
  // anything past the first page in workspaces with hundreds of projects.
  if (looksLikeId(nameOrId)) {
    try {
      const project = await client.getProject(workspaceId, nameOrId);
      return { match: project, candidates: [project] };
    } catch (err) {
      // A bad id comes back as 400 ("doesn't belong to workspace"), not 404.
      if (err instanceof ClockifyError && (err.status === 400 || err.status === 404)) {
        return { match: null, candidates: [] };
      }
      throw err;
    }
  }
  const projects = await client.listProjects(workspaceId, { name: nameOrId });
  return pickByName(projects, nameOrId);
}

export async function resolveTask(
  client: ClockifyClient,
  workspaceId: string,
  projectId: string,
  nameOrId: string
): Promise<ResolveResult<Task>> {
  if (looksLikeId(nameOrId)) {
    try {
      const task = await client.getTask(workspaceId, projectId, nameOrId);
      return { match: task, candidates: [task] };
    } catch (err) {
      if (err instanceof ClockifyError && (err.status === 400 || err.status === 404)) {
        return { match: null, candidates: [] };
      }
      // Some tokens are barred from reading tasks. Trust the id and let the
      // write itself be the thing that fails if the id is wrong.
      if (err instanceof ClockifyError && (err.status === 401 || err.status === 403)) {
        return {
          match: { id: nameOrId, name: nameOrId, projectId, status: "UNKNOWN" },
          candidates: [],
        };
      }
      throw err;
    }
  }

  let tasks: Task[];
  try {
    tasks = await client.listTasks(workspaceId, projectId, {});
  } catch (err) {
    if (err instanceof ClockifyError && (err.status === 401 || err.status === 403)) {
      return {
        match: null,
        candidates: [],
        error:
          "This Clockify token is not allowed to browse tasks by name. " +
          "Pass the task id instead — ids work fine.",
      };
    }
    throw err;
  }
  return pickByName(tasks, nameOrId);
}

export async function resolveTags(
  client: ClockifyClient,
  workspaceId: string,
  namesOrIds: string[]
): Promise<{ ids: string[]; unresolved: string[]; ambiguous: { input: string; matches: Tag[] }[] }> {
  const allTags = await client.listTags(workspaceId, {});
  const ids: string[] = [];
  const unresolved: string[] = [];
  const ambiguous: { input: string; matches: Tag[] }[] = [];
  for (const input of namesOrIds) {
    if (looksLikeId(input)) {
      const match = allTags.find((t) => t.id === input);
      if (match) ids.push(match.id);
      else unresolved.push(input);
      continue;
    }
    const result = pickByName(allTags, input);
    if (result.match) ids.push(result.match.id);
    else if (result.candidates.length > 1) ambiguous.push({ input, matches: result.candidates });
    else unresolved.push(input);
  }
  return { ids, unresolved, ambiguous };
}

function pickByName<T extends { name: string }>(
  items: T[],
  query: string
): ResolveResult<T> {
  const q = query.trim().toLowerCase();
  const exact = items.filter((i) => i.name.toLowerCase() === q);
  if (exact.length === 1) return { match: exact[0], candidates: exact };
  if (exact.length > 1) return { match: null, candidates: exact };

  const contains = items.filter((i) => i.name.toLowerCase().includes(q));
  if (contains.length === 1) return { match: contains[0], candidates: contains };
  return { match: null, candidates: contains };
}
