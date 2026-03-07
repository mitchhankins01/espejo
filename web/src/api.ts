export interface Artifact {
  id: string;
  kind: "insight" | "theory" | "model" | "reference";
  title: string;
  body: string;
  tags: string[];
  has_embedding: boolean;
  created_at: string;
  updated_at: string;
  version: number;
  source_entry_uuids: string[];
}

export interface EntrySearchResult {
  uuid: string;
  created_at: string;
  preview: string;
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
  const res = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init?.headers,
    },
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
  limit?: number;
  offset?: number;
}): Promise<{ items: Artifact[]; total: number }> {
  const qs = new URLSearchParams();
  if (params?.kind) qs.set("kind", params.kind);
  if (params?.tags) qs.set("tags", params.tags);
  if (params?.limit) qs.set("limit", String(params.limit));
  if (params?.offset) qs.set("offset", String(params.offset));
  const query = qs.toString();
  return apiFetch(`/api/artifacts${query ? `?${query}` : ""}`);
}

export function searchArtifacts(q: string, kind?: string): Promise<Artifact[]> {
  const qs = new URLSearchParams({ q });
  if (kind) qs.set("kind", kind);
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

export function searchEntries(q: string): Promise<EntrySearchResult[]> {
  return apiFetch(`/api/entries/search?q=${encodeURIComponent(q)}`);
}
