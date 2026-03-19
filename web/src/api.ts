export type ArtifactKind =
  | "insight"
  | "theory"
  | "model"
  | "reference"
  | "note";

export interface Artifact {
  id: string;
  kind: ArtifactKind;
  title: string;
  body: string;
  tags: string[];
  has_embedding: boolean;
  source: "web" | "obsidian" | "mcp" | "telegram";
  source_path: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  source_entry_uuids: string[];
}

export interface ArtifactTitle {
  id: string;
  title: string;
  kind: ArtifactKind;
}

export interface RelatedArtifacts {
  semantic: Array<{
    id: string;
    title: string;
    kind: ArtifactKind;
    similarity: number;
  }>;
  explicit: Array<{
    id: string;
    title: string;
    kind: ArtifactKind;
    direction: "outgoing" | "incoming";
  }>;
}

export interface GraphData {
  nodes: Array<{
    id: string;
    title: string;
    kind: ArtifactKind;
    tags: string[];
  }>;
  edges: Array<{
    source: string;
    target: string;
    type: "semantic" | "explicit" | "tag" | "source";
    weight?: number;
  }>;
}

export interface EntrySearchResult {
  uuid: string;
  created_at: string;
  preview: string;
}

export type EntrySource = "dayone" | "web" | "telegram";

export interface EntryMedia {
  id: number;
  type: "photo" | "video" | "audio";
  url: string;
  dimensions: { width: number; height: number } | null;
  storage_key?: string | null;
}

export interface Entry {
  id: number;
  uuid: string;
  text: string;
  created_at: string;
  modified_at: string | null;
  timezone: string | null;
  source: EntrySource;
  version: number;
  city: string | null;
  country: string | null;
  place_name: string | null;
  admin_area: string | null;
  latitude: number | null;
  longitude: number | null;
  temperature: number | null;
  weather_conditions: string | null;
  humidity: number | null;
  tags: string[];
  photo_count: number;
  video_count: number;
  audio_count: number;
  media: EntryMedia[];
}

export interface EntryTemplate {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  body: string;
  system_prompt: string | null;
  default_tags: string[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export type TodoStatus = "active" | "waiting" | "done" | "someday";

export interface Todo {
  id: string;
  title: string;
  status: TodoStatus;
  next_step: string | null;
  body: string;
  tags: string[];
  urgent: boolean;
  important: boolean;
  is_focus: boolean;
  parent_id: string | null;
  sort_order: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  children?: Todo[];
}

export interface WeightEntry {
  date: string;
  weight_kg: number;
  created_at: string;
}

export interface WeightPatterns {
  latest: { date: string; weight_kg: number } | null;
  delta_7d: number | null;
  delta_30d: number | null;
  weekly_pace_kg: number | null;
  consistency: number | null;
  streak_days: number;
  volatility_14d: number | null;
  plateau: boolean;
  range_days: number;
  logged_days: number;
}

export type ObservableDbTableName =
  | "knowledge_artifacts"
  | "artifact_links"
  | "todos"
  | "activity_logs"
  | "chat_messages"
  | "patterns"
  | "daily_metrics";

export interface DbTableMeta {
  name: ObservableDbTableName;
  row_count: number;
  last_changed_at: string | null;
  default_sort_column: string | null;
}

export interface DbColumnMeta {
  name: string;
  type: string;
  hidden: boolean;
}

export interface DbRowsResult {
  items: Record<string, unknown>[];
  total: number;
  columns: DbColumnMeta[];
}

export type DbChangeOperation = "insert" | "update" | "delete" | "tool_call";

export interface DbChangeEvent {
  changed_at: string;
  table: ObservableDbTableName;
  operation: DbChangeOperation;
  row_id: string | null;
  summary: string;
  changed_fields?: Array<{
    field: string;
    before: unknown;
    after: unknown;
  }>;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  tool_name?: string;
  chat_id?: string;
}

const TOKEN_KEY = "espejo_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  const headers = new Headers(init?.headers ?? {});
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token && !headers.has("Authorization")) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(path, {
    ...init,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    const err = new Error(body.error || `HTTP ${res.status}`);
    (err as Error & { status: number }).status = res.status;
    throw err;
  }

  return res.json() as Promise<T>;
}

export function listArtifacts(params?: {
  kind?: string;
  tags?: string;
  tags_mode?: "any" | "all";
  limit?: number;
  offset?: number;
}): Promise<{ items: Artifact[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.kind) qs.set("kind", params.kind);
  if (params?.tags) qs.set("tags", params.tags);
  if (params?.tags_mode) qs.set("tags_mode", params.tags_mode);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return apiFetch(`/api/artifacts${query ? `?${query}` : ""}`);
}

export function searchArtifacts(
  q: string,
  kind?: string,
  tags?: string,
  tagsMode?: "any" | "all",
  semantic?: boolean
): Promise<Artifact[]> {
  const qs = new URLSearchParams({ q });
  if (kind) qs.set("kind", kind);
  if (tags) qs.set("tags", tags);
  if (tagsMode) qs.set("tags_mode", tagsMode);
  if (semantic !== undefined) qs.set("semantic", String(semantic));
  return apiFetch(`/api/artifacts?${qs.toString()}`);
}

export function getArtifact(id: string): Promise<Artifact> {
  return apiFetch(`/api/artifacts/${id}`);
}

export function createArtifact(data: {
  kind: string;
  title: string;
  body: string;
  tags?: string[];
  source_entry_uuids?: string[];
}): Promise<Artifact> {
  return apiFetch("/api/artifacts", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateArtifact(
  id: string,
  data: {
    kind?: string;
    title?: string;
    body?: string;
    tags?: string[];
    source_entry_uuids?: string[];
    expected_version: number;
  }
): Promise<Artifact> {
  return apiFetch(`/api/artifacts/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteArtifact(id: string): Promise<void> {
  return apiFetch(`/api/artifacts/${id}`, { method: "DELETE" });
}

export function listArtifactTags(): Promise<{ name: string; count: number }[]> {
  return apiFetch("/api/artifacts/tags");
}

export function listArtifactTitles(): Promise<ArtifactTitle[]> {
  return apiFetch("/api/artifacts/titles");
}

export function getRelatedArtifacts(id: string): Promise<RelatedArtifacts> {
  return apiFetch(`/api/artifacts/${id}/related`);
}

export function getArtifactGraph(): Promise<GraphData> {
  return apiFetch("/api/artifacts/graph");
}

export function searchEntries(q: string): Promise<EntrySearchResult[]> {
  return apiFetch(`/api/entries/search?q=${encodeURIComponent(q)}`);
}

export function listEntryTags(): Promise<{ name: string; count: number }[]> {
  return apiFetch("/api/entries/tags");
}

export function listEntries(params?: {
  limit?: number;
  offset?: number;
  from?: string;
  to?: string;
  tag?: string;
  source?: EntrySource;
  q?: string;
}): Promise<{ items: Entry[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  if (params?.from) qs.set("from", params.from);
  if (params?.to) qs.set("to", params.to);
  if (params?.tag) qs.set("tag", params.tag);
  if (params?.source) qs.set("source", params.source);
  if (params?.q) qs.set("q", params.q);
  const query = qs.toString();
  return apiFetch(`/api/entries${query ? `?${query}` : ""}`);
}

export function getEntry(uuid: string): Promise<Entry> {
  return apiFetch(`/api/entries/${encodeURIComponent(uuid)}`);
}

export function createEntry(data: {
  text: string;
  created_at?: string;
  timezone?: string;
  tags?: string[];
}): Promise<Entry> {
  return apiFetch("/api/entries", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateEntry(
  uuid: string,
  data: {
    text?: string;
    created_at?: string;
    timezone?: string;
    tags?: string[];
    expected_version: number;
  }
): Promise<Entry> {
  return apiFetch(`/api/entries/${encodeURIComponent(uuid)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteEntry(uuid: string): Promise<{ status: "deleted" }> {
  return apiFetch(`/api/entries/${encodeURIComponent(uuid)}`, {
    method: "DELETE",
  });
}

export function uploadEntryMedia(
  uuid: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<EntryMedia> {
  const token = getToken();
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/entries/${encodeURIComponent(uuid)}/media`);
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }

    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable || !onProgress) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      onProgress(percent);
    };

    xhr.onerror = () => {
      reject(new Error("Upload failed. Check your network and try again."));
    };

    xhr.onload = () => {
      let payload: unknown = null;
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : null;
      } catch {
        payload = null;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as EntryMedia);
        return;
      }

      const message =
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof (payload as { error: unknown }).error === "string"
          ? (payload as { error: string }).error
          : `HTTP ${xhr.status}`;
      reject(new Error(message));
    };

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}

export function deleteEntryMedia(id: number): Promise<{ status: "deleted" }> {
  return apiFetch(`/api/media/${id}`, {
    method: "DELETE",
  });
}

export function listTemplates(): Promise<EntryTemplate[]> {
  return apiFetch("/api/templates");
}

export function getTemplate(id: string): Promise<EntryTemplate> {
  return apiFetch(`/api/templates/${encodeURIComponent(id)}`);
}

export function createTemplate(data: {
  slug: string;
  name: string;
  description?: string | null;
  body: string;
  default_tags?: string[];
  sort_order?: number;
}): Promise<EntryTemplate> {
  return apiFetch("/api/templates", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateTemplate(
  id: string,
  data: {
    slug?: string;
    name?: string;
    description?: string | null;
    body?: string;
    default_tags?: string[];
    sort_order?: number;
  }
): Promise<EntryTemplate> {
  return apiFetch(`/api/templates/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteTemplate(id: string): Promise<{ status: "deleted" }> {
  return apiFetch(`/api/templates/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
}

export function listTodos(params?: {
  status?: TodoStatus;
  urgent?: boolean;
  important?: boolean;
  parent_id?: string;
  focus_only?: boolean;
  include_children?: boolean;
  limit?: number;
  offset?: number;
}): Promise<{ items: Todo[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.status) qs.set("status", params.status);
  if (params?.urgent !== undefined) qs.set("urgent", String(params.urgent));
  if (params?.important !== undefined) qs.set("important", String(params.important));
  if (params?.parent_id) qs.set("parent_id", params.parent_id);
  if (params?.focus_only) qs.set("focus_only", "true");
  if (params?.include_children) qs.set("include_children", "true");
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return apiFetch(`/api/todos${query ? `?${query}` : ""}`);
}

export function getTodo(id: string): Promise<Todo> {
  return apiFetch(`/api/todos/${id}`);
}

export function createTodo(data: {
  title: string;
  status?: TodoStatus;
  next_step?: string | null;
  body?: string;
  tags?: string[];
  urgent?: boolean;
  important?: boolean;
  parent_id?: string;
}): Promise<Todo> {
  return apiFetch("/api/todos", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export function updateTodo(
  id: string,
  data: {
    title?: string;
    status?: TodoStatus;
    next_step?: string | null;
    body?: string;
    tags?: string[];
    urgent?: boolean;
    important?: boolean;
  }
): Promise<Todo> {
  return apiFetch(`/api/todos/${id}`, {
    method: "PUT",
    body: JSON.stringify(data),
  });
}

export function deleteTodo(id: string): Promise<void> {
  return apiFetch(`/api/todos/${id}`, { method: "DELETE" });
}

export function completeTodo(id: string): Promise<Todo> {
  return apiFetch(`/api/todos/${id}/complete`, { method: "POST" });
}

export function setFocus(id: string): Promise<Todo> {
  return apiFetch("/api/todos/focus", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
}

export function clearFocus(): Promise<void> {
  return apiFetch("/api/todos/focus", {
    method: "POST",
    body: JSON.stringify({ clear: true }),
  });
}

export function getFocus(): Promise<Todo | null> {
  return apiFetch("/api/todos/focus");
}

export function listWeights(params?: {
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
}): Promise<{ items: WeightEntry[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set("from", params.from);
  if (params?.to) qs.set("to", params.to);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return apiFetch(`/api/weights${query ? `?${query}` : ""}`);
}

export function upsertWeight(date: string, weightKg: number): Promise<WeightEntry> {
  return apiFetch(`/api/weights/${encodeURIComponent(date)}`, {
    method: "PUT",
    body: JSON.stringify({ weight_kg: weightKg }),
  });
}

export function deleteWeight(date: string): Promise<{ status: "deleted" }> {
  return apiFetch(`/api/weights/${encodeURIComponent(date)}`, {
    method: "DELETE",
  });
}

export function getWeightPatterns(params?: {
  from?: string;
  to?: string;
}): Promise<WeightPatterns> {
  const qs = new URLSearchParams();
  if (params?.from) qs.set("from", params.from);
  if (params?.to) qs.set("to", params.to);
  const query = qs.toString();
  return apiFetch(`/api/weights/patterns${query ? `?${query}` : ""}`);
}

export function listDbTables(): Promise<DbTableMeta[]> {
  return apiFetch("/api/db/tables");
}

export function listDbTableRows(
  table: ObservableDbTableName,
  params?: {
    limit?: number;
    offset?: number;
    sort?: string;
    order?: "asc" | "desc";
    q?: string;
    from?: string;
    to?: string;
  }
): Promise<DbRowsResult> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  if (params?.sort) qs.set("sort", params.sort);
  if (params?.order) qs.set("order", params.order);
  if (params?.q) qs.set("q", params.q);
  if (params?.from) qs.set("from", params.from);
  if (params?.to) qs.set("to", params.to);
  const query = qs.toString();
  return apiFetch(
    `/api/db/tables/${encodeURIComponent(table)}/rows${query ? `?${query}` : ""}`
  );
}

export function listDbChanges(params?: {
  limit?: number;
  since?: string;
  table?: ObservableDbTableName;
  operation?: DbChangeOperation;
}): Promise<DbChangeEvent[]> {
  const qs = new URLSearchParams();
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.since) qs.set("since", params.since);
  if (params?.table) qs.set("table", params.table);
  if (params?.operation) qs.set("operation", params.operation);
  const query = qs.toString();
  return apiFetch(`/api/db/changes${query ? `?${query}` : ""}`);
}
