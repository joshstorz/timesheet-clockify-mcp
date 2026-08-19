const API_BASE = "https://api.clockify.me/api/v1";
const REPORTS_BASE = "https://reports.api.clockify.me/v1";
const MAX_PAGES = 50;

export class ClockifyError extends Error {
  constructor(message: string, public status?: number, public body?: unknown) {
    super(message);
    this.name = "ClockifyError";
  }
}

export interface User {
  id: string;
  name: string;
  email: string;
  activeWorkspace: string;
  defaultWorkspace: string;
}

export interface Project {
  id: string;
  name: string;
  clientId: string;
  clientName: string;
  archived: boolean;
  billable: boolean;
  color: string;
}

export interface Task {
  id: string;
  name: string;
  projectId: string;
  status: string;
}

export interface Tag {
  id: string;
  name: string;
  archived: boolean;
}

export interface TimeInterval {
  start: string;
  end: string | null;
  duration: string | null;
}

export interface TimeEntry {
  id: string;
  description: string;
  projectId: string | null;
  taskId: string | null;
  tagIds: string[];
  billable: boolean;
  timeInterval: TimeInterval;
  workspaceId: string;
  userId: string;
}

export interface CreateEntryInput {
  start: string;
  end?: string;
  description?: string;
  projectId?: string;
  taskId?: string;
  tagIds?: string[];
  billable?: boolean;
}

export interface UpdateEntryInput {
  start?: string;
  end?: string;
  description?: string;
  projectId?: string;
  taskId?: string;
  tagIds?: string[];
  billable?: boolean;
}

export interface SummaryReportInput {
  dateRangeStart: string;
  dateRangeEnd: string;
  groupBy: "PROJECT" | "CLIENT" | "TAG" | "TASK" | "USER" | "DATE";
  billable?: boolean;
  projectIds?: string[];
  clientIds?: string[];
  userIds?: string[];
}

export interface DetailedReportInput {
  dateRangeStart: string;
  dateRangeEnd: string;
  billable?: boolean;
  projectIds?: string[];
  clientIds?: string[];
  userIds?: string[];
  page?: number;
  pageSize?: number;
}

export class ClockifyClient {
  constructor(private apiKey: string) {}

  private async request<T>(
    method: string,
    url: string,
    body?: unknown
  ): Promise<T> {
    const res = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": this.apiKey,
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const text = await res.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {}
      throw new ClockifyError(
        `Clockify ${method} ${url} failed: ${res.status} ${res.statusText}`,
        res.status,
        parsed
      );
    }

    if (res.status === 204) return undefined as T;
    const text = await res.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }

  /**
   * Clockify caps every list endpoint at one page. Walk pages until a short
   * batch comes back so workspaces with hundreds of projects resolve fully.
   */
  private async requestAllPages<T>(
    baseUrl: string,
    qs: URLSearchParams,
    pageSize = 200
  ): Promise<T[]> {
    const all: T[] = [];
    qs.set("page-size", String(pageSize));
    for (let page = 1; page <= MAX_PAGES; page++) {
      qs.set("page", String(page));
      const batch = await this.request<T[]>("GET", `${baseUrl}?${qs.toString()}`);
      if (!batch?.length) break;
      all.push(...batch);
      if (batch.length < pageSize) break;
    }
    return all;
  }

  getUser(): Promise<User> {
    return this.request<User>("GET", `${API_BASE}/user`);
  }

  listTimeEntries(
    workspaceId: string,
    userId: string,
    params: {
      start?: string;
      end?: string;
      inProgress?: boolean;
      page?: number;
      pageSize?: number;
      hydrated?: boolean;
    } = {}
  ): Promise<TimeEntry[]> {
    const qs = new URLSearchParams();
    if (params.start) qs.set("start", params.start);
    if (params.end) qs.set("end", params.end);
    if (params.inProgress) qs.set("in-progress", "true");
    if (params.page) qs.set("page", String(params.page));
    if (params.pageSize) qs.set("page-size", String(params.pageSize));
    if (params.hydrated) qs.set("hydrated", "true");
    const q = qs.toString();
    return this.request<TimeEntry[]>(
      "GET",
      `${API_BASE}/workspaces/${workspaceId}/user/${userId}/time-entries${q ? "?" + q : ""}`
    );
  }

  createTimeEntry(workspaceId: string, input: CreateEntryInput): Promise<TimeEntry> {
    return this.request<TimeEntry>(
      "POST",
      `${API_BASE}/workspaces/${workspaceId}/time-entries`,
      input
    );
  }

  stopCurrentTimer(
    workspaceId: string,
    userId: string,
    end: string
  ): Promise<TimeEntry> {
    return this.request<TimeEntry>(
      "PATCH",
      `${API_BASE}/workspaces/${workspaceId}/user/${userId}/time-entries`,
      { end }
    );
  }

  updateTimeEntry(
    workspaceId: string,
    entryId: string,
    input: UpdateEntryInput & { start: string }
  ): Promise<TimeEntry> {
    return this.request<TimeEntry>(
      "PUT",
      `${API_BASE}/workspaces/${workspaceId}/time-entries/${entryId}`,
      input
    );
  }

  deleteTimeEntry(workspaceId: string, entryId: string): Promise<void> {
    return this.request<void>(
      "DELETE",
      `${API_BASE}/workspaces/${workspaceId}/time-entries/${entryId}`
    );
  }

  getTimeEntry(workspaceId: string, entryId: string): Promise<TimeEntry> {
    return this.request<TimeEntry>(
      "GET",
      `${API_BASE}/workspaces/${workspaceId}/time-entries/${entryId}`
    );
  }

  listProjects(
    workspaceId: string,
    params: { name?: string; archived?: boolean; pageSize?: number } = {}
  ): Promise<Project[]> {
    const qs = new URLSearchParams();
    if (params.name) qs.set("name", params.name);
    if (params.archived !== undefined) qs.set("archived", String(params.archived));
    return this.requestAllPages<Project>(
      `${API_BASE}/workspaces/${workspaceId}/projects`,
      qs,
      params.pageSize ?? 200
    );
  }

  getProject(workspaceId: string, projectId: string): Promise<Project> {
    return this.request<Project>(
      "GET",
      `${API_BASE}/workspaces/${workspaceId}/projects/${projectId}`
    );
  }

  listTasks(
    workspaceId: string,
    projectId: string,
    params: { name?: string; pageSize?: number } = {}
  ): Promise<Task[]> {
    const qs = new URLSearchParams();
    if (params.name) qs.set("name", params.name);
    return this.requestAllPages<Task>(
      `${API_BASE}/workspaces/${workspaceId}/projects/${projectId}/tasks`,
      qs,
      params.pageSize ?? 200
    );
  }

  getTask(workspaceId: string, projectId: string, taskId: string): Promise<Task> {
    return this.request<Task>(
      "GET",
      `${API_BASE}/workspaces/${workspaceId}/projects/${projectId}/tasks/${taskId}`
    );
  }

  listTags(
    workspaceId: string,
    params: { name?: string; archived?: boolean } = {}
  ): Promise<Tag[]> {
    const qs = new URLSearchParams();
    if (params.name) qs.set("name", params.name);
    if (params.archived !== undefined) qs.set("archived", String(params.archived));
    return this.requestAllPages<Tag>(
      `${API_BASE}/workspaces/${workspaceId}/tags`,
      qs
    );
  }

  summaryReport(workspaceId: string, input: SummaryReportInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      dateRangeStart: input.dateRangeStart,
      dateRangeEnd: input.dateRangeEnd,
      summaryFilter: {
        groups: [input.groupBy],
      },
      exportType: "JSON",
    };
    if (input.billable !== undefined) body.billable = input.billable;
    if (input.projectIds?.length) body.projects = { ids: input.projectIds, contains: "CONTAINS" };
    if (input.clientIds?.length) body.clients = { ids: input.clientIds, contains: "CONTAINS" };
    if (input.userIds?.length) body.users = { ids: input.userIds, contains: "CONTAINS" };
    return this.request(
      "POST",
      `${REPORTS_BASE}/workspaces/${workspaceId}/reports/summary`,
      body
    );
  }

  detailedReport(workspaceId: string, input: DetailedReportInput): Promise<unknown> {
    const body: Record<string, unknown> = {
      dateRangeStart: input.dateRangeStart,
      dateRangeEnd: input.dateRangeEnd,
      detailedFilter: {
        page: input.page ?? 1,
        pageSize: input.pageSize ?? 50,
      },
      exportType: "JSON",
    };
    if (input.billable !== undefined) body.billable = input.billable;
    if (input.projectIds?.length) body.projects = { ids: input.projectIds, contains: "CONTAINS" };
    if (input.clientIds?.length) body.clients = { ids: input.clientIds, contains: "CONTAINS" };
    if (input.userIds?.length) body.users = { ids: input.userIds, contains: "CONTAINS" };
    return this.request(
      "POST",
      `${REPORTS_BASE}/workspaces/${workspaceId}/reports/detailed`,
      body
    );
  }
}
