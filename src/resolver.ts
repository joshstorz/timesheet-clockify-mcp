import { ClockifyClient, ClockifyError, Project, Tag } from "./clockify.js";

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

export function pickByName<T extends { name: string }>(
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
