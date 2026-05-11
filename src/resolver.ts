import { ClockifyClient, Project, Task, Tag } from "./clockify.js";

const ID_RE = /^[a-f0-9]{24}$/i;

export function looksLikeId(value: string): boolean {
  return ID_RE.test(value);
}

export interface ResolveResult<T> {
  match: T | null;
  candidates: T[];
}

export async function resolveProject(
  client: ClockifyClient,
  workspaceId: string,
  nameOrId: string
): Promise<ResolveResult<Project>> {
  if (looksLikeId(nameOrId)) {
    const projects = await client.listProjects(workspaceId, {});
    const match = projects.find((p) => p.id === nameOrId) ?? null;
    return { match, candidates: match ? [match] : [] };
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
  const tasks = await client.listTasks(workspaceId, projectId, {});
  if (looksLikeId(nameOrId)) {
    const match = tasks.find((t) => t.id === nameOrId) ?? null;
    return { match, candidates: match ? [match] : [] };
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
