import { ClockifyError, TimeEntry, UpdateEntryInput } from "./clockify.js";

export function isTaskValidationError(err: unknown): err is ClockifyError {
  if (!(err instanceof ClockifyError) || err.status !== 400 || !err.body || typeof err.body !== "object") return false;
  const body = err.body as { code?: unknown; message?: unknown };
  return Number(body.code) === 501 && typeof body.message === "string" && /\btask\b/i.test(body.message);
}

export interface EntryWriteContext {
  operation: "start-timer" | "stop-timer" | "log-past-entry" | "edit-entry";
  workspaceId: string;
  userId: string;
  entryId?: string;
  projectId?: string | null;
  existingTaskId?: string | null;
  attemptedTaskId?: string | null;
  requestedEnd?: string;
}

export class TaskRequiredError extends Error {
  constructor(public context: EntryWriteContext) {
    super("Clockify requires an active task, or the supplied task is completed. Choose a task for this project and retry with its name or id.");
    this.name = "TaskRequiredError";
  }
}

export function preserveEntry(entry: TimeEntry): UpdateEntryInput & { start: string } {
  return {
    start: entry.timeInterval.start,
    ...(entry.timeInterval.end ? { end: entry.timeInterval.end } : {}),
    projectId: entry.projectId,
    taskId: entry.taskId,
    description: entry.description,
    billable: entry.billable,
    tagIds: entry.tagIds ?? [],
    ...(entry.type ? { type: entry.type } : {}),
    ...(entry.customFieldValues ? {
      customFields: entry.customFieldValues.map(({ customFieldId, value }) => ({ customFieldId, value })),
    } : {}),
  };
}

export function validateInterval(start: string, end?: string) {
  if (end && new Date(end).getTime() <= new Date(start).getTime()) {
    throw new Error("End time must be after the entry's start time.");
  }
}
