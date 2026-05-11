import { Project, Tag, Task, TimeEntry } from "./clockify.js";

export function isoNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function toIso(input: string): string {
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid date: ${input}`);
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function parseDuration(iso: string | null | undefined): number {
  if (!iso) return 0;
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso);
  if (!m) return 0;
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const s = parseFloat(m[3] ?? "0");
  return h * 3600 + min * 60 + s;
}

export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

export function durationBetween(startIso: string, endIso: string): number {
  return (new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000;
}

export function summarizeEntry(
  entry: TimeEntry,
  projectsById: Map<string, Project> = new Map(),
  tasksById: Map<string, Task> = new Map(),
  tagsById: Map<string, Tag> = new Map()
): string {
  const project = entry.projectId ? projectsById.get(entry.projectId)?.name ?? entry.projectId : "(no project)";
  const task = entry.taskId ? tasksById.get(entry.taskId)?.name ?? entry.taskId : null;
  const tags = (entry.tagIds ?? []).map((id) => tagsById.get(id)?.name ?? id).filter(Boolean);
  const desc = entry.description || "(no description)";

  const start = entry.timeInterval.start;
  const end = entry.timeInterval.end;
  let durationLabel: string;
  if (end) {
    const seconds = entry.timeInterval.duration
      ? parseDuration(entry.timeInterval.duration)
      : durationBetween(start, end);
    durationLabel = formatDuration(seconds);
  } else {
    durationLabel = `running (since ${start})`;
  }

  const billable = entry.billable ? " [billable]" : "";
  const tagSuffix = tags.length ? ` #${tags.join(" #")}` : "";
  const taskSuffix = task ? ` › ${task}` : "";

  return `${durationLabel} — ${project}${taskSuffix} — ${desc}${billable}${tagSuffix}`;
}
