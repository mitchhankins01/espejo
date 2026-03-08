import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  listDbChanges,
  listDbTableRows,
  listDbTables,
  type DbChangeEvent,
  type DbChangeOperation,
  type DbColumnMeta,
  type DbTableMeta,
  type ObservableDbTableName,
} from "../api.ts";

const PAGE_SIZE = 50;
const CHANGE_REFRESH_MS = 5000;
const CHANGE_WINDOWS = [
  { label: "15m", minutes: 15 },
  { label: "1h", minutes: 60 },
  { label: "6h", minutes: 360 },
  { label: "24h", minutes: 1440 },
] as const;

const OBSERVABLE_TABLE_NAMES: ObservableDbTableName[] = [
  "knowledge_artifacts",
  "artifact_links",
  "todos",
  "activity_logs",
  "chat_messages",
  "patterns",
  "spanish_vocabulary",
  "spanish_reviews",
  "daily_metrics",
  "insights",
  "checkins",
];

type DbTab = "explorer" | "changes";

function isObservableDbTableName(value: string | null): value is ObservableDbTableName {
  if (!value) return false;
  return OBSERVABLE_TABLE_NAMES.includes(value as ObservableDbTableName);
}

function formatDateTime(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleString();
}

function stringifyCell(value: unknown): string {
  if (value == null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function stringifyCompact(value: unknown): string {
  const text = stringifyCell(value);
  return text.length > 80 ? `${text.slice(0, 80)}...` : text;
}

function toRangeStartIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function toRangeEndIso(value: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(`${value}T23:59:59.999`);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function rowDetailLinks(
  table: ObservableDbTableName | null,
  row: Record<string, unknown> | null
): Array<{ to: string; label: string }> {
  if (!table || !row) return [];
  const links: Array<{ to: string; label: string }> = [];

  if (table === "knowledge_artifacts" && typeof row.id === "string") {
    links.push({ to: `/${row.id}`, label: "Open artifact" });
  }
  if (table === "todos" && typeof row.id === "string") {
    links.push({ to: `/todos/${row.id}`, label: "Open todo" });
  }
  if (table === "checkins" && typeof row.artifact_id === "string") {
    links.push({ to: `/${row.artifact_id}`, label: "Open linked artifact" });
  }

  return links;
}

export function DbObservability() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialTab: DbTab = searchParams.get("tab") === "changes" ? "changes" : "explorer";
  const tableFromQuery = searchParams.get("table");
  const initialTable = isObservableDbTableName(tableFromQuery) ? tableFromQuery : null;

  const [tab, setTab] = useState<DbTab>(initialTab);
  const [tables, setTables] = useState<DbTableMeta[]>([]);
  const [explorerTable, setExplorerTable] = useState<ObservableDbTableName | null>(initialTable);
  const [changeTableFilter, setChangeTableFilter] = useState<ObservableDbTableName | null>(
    initialTab === "changes" ? initialTable : null
  );

  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<DbColumnMeta[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowPage, setRowPage] = useState(0);
  const [rowSearch, setRowSearch] = useState("");
  const [rowFrom, setRowFrom] = useState("");
  const [rowTo, setRowTo] = useState("");
  const [rowSort, setRowSort] = useState("");
  const [rowOrder, setRowOrder] = useState<"asc" | "desc">("desc");
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null);

  const [changes, setChanges] = useState<DbChangeEvent[]>([]);
  const [changeOperation, setChangeOperation] = useState<DbChangeOperation | "">("");
  const [changeWindowMinutes, setChangeWindowMinutes] = useState<number>(60);
  const [changePaused, setChangePaused] = useState(false);
  const [expandedChangeKeys, setExpandedChangeKeys] = useState<Record<string, boolean>>({});

  const [loadingTables, setLoadingTables] = useState(true);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [error, setError] = useState("");

  const totalRowPages = Math.ceil(rowsTotal / PAGE_SIZE);
  const selectedColumns = useMemo(
    () => columns.filter((column) => !column.hidden),
    [columns]
  );
  const sortColumns = useMemo(() => columns.map((column) => column.name), [columns]);

  const tableMetaByName = useMemo(() => {
    const map = new Map<ObservableDbTableName, DbTableMeta>();
    for (const tableMeta of tables) {
      map.set(tableMeta.name, tableMeta);
    }
    return map;
  }, [tables]);

  useEffect(() => {
    const activeTable = tab === "explorer" ? explorerTable : changeTableFilter;
    const next = new URLSearchParams();
    next.set("tab", tab);
    if (activeTable) next.set("table", activeTable);
    const current = searchParams.toString();
    const target = next.toString();
    if (current !== target) {
      setSearchParams(next, { replace: true });
    }
  }, [tab, explorerTable, changeTableFilter, searchParams, setSearchParams]);

  const loadTables = useCallback(async (): Promise<void> => {
    setLoadingTables(true);
    setError("");
    try {
      const metas = await listDbTables();
      setTables(metas);
      if (!explorerTable && metas[0]) {
        setExplorerTable(metas[0].name);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingTables(false);
    }
  }, [explorerTable]);

  const loadRows = useCallback(async (): Promise<void> => {
    if (!explorerTable) return;
    setLoadingRows(true);
    setError("");
    try {
      const defaultSort = tableMetaByName.get(explorerTable)?.default_sort_column ?? undefined;
      const result = await listDbTableRows(explorerTable, {
        limit: PAGE_SIZE,
        offset: rowPage * PAGE_SIZE,
        sort: rowSort || defaultSort || undefined,
        order: rowOrder,
        q: rowSearch.trim() || undefined,
        from: toRangeStartIso(rowFrom),
        to: toRangeEndIso(rowTo),
      });
      setRows(result.items);
      setRowsTotal(result.total);
      setColumns(result.columns);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingRows(false);
    }
  }, [explorerTable, rowPage, rowSort, rowOrder, rowSearch, rowFrom, rowTo, tableMetaByName]);

  const loadChanges = useCallback(async (): Promise<void> => {
    setLoadingChanges(true);
    setError("");
    try {
      const since = new Date(Date.now() - changeWindowMinutes * 60_000).toISOString();
      const result = await listDbChanges({
        limit: 200,
        since,
        table: changeTableFilter ?? undefined,
        operation: changeOperation || undefined,
      });
      setChanges(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingChanges(false);
    }
  }, [changeOperation, changeTableFilter, changeWindowMinutes]);

  useEffect(() => {
    void loadTables();
  }, [loadTables]);

  useEffect(() => {
    if (tab !== "explorer") return;
    void loadRows();
  }, [loadRows, tab]);

  useEffect(() => {
    if (tab !== "changes") return;
    if (changePaused) return;
    void loadChanges();
    const timer = setInterval(() => {
      void loadChanges();
    }, CHANGE_REFRESH_MS);
    return () => clearInterval(timer);
  }, [changePaused, loadChanges, tab]);

  useEffect(() => {
    setRowPage(0);
    setSelectedRow(null);
    setRowSort("");
  }, [explorerTable, rowSearch, rowFrom, rowTo, rowOrder]);

  useEffect(() => {
    if (!explorerTable) return;
    if (rowSort) return;
    const defaultSort = tableMetaByName.get(explorerTable)?.default_sort_column;
    if (defaultSort) setRowSort(defaultSort);
  }, [explorerTable, rowSort, tableMetaByName]);

  const selectedRowLinks = rowDetailLinks(explorerTable, selectedRow);

  return (
    <div className="max-w-7xl mx-auto px-4 py-8 pb-24">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-xl font-semibold text-text-primary">DB Observatory</h1>
        <div className="flex items-center gap-1 rounded-lg border border-border bg-surface p-1">
          <button
            onClick={() => setTab("explorer")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "explorer"
                ? "bg-pine-600 dark:bg-pine-500 text-white"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            Explorer
          </button>
          <button
            onClick={() => setTab("changes")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === "changes"
                ? "bg-pine-600 dark:bg-pine-500 text-white"
                : "text-text-muted hover:text-text-primary"
            }`}
          >
            Recent Changes
          </button>
        </div>
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[280px_1fr] gap-4">
        <aside className="bg-surface border border-border rounded-xl p-3 h-fit">
          <h2 className="text-sm font-semibold text-text-primary mb-2">Tables</h2>
          {loadingTables ? (
            <div className="text-sm text-text-muted py-4">Loading...</div>
          ) : (
            <div className="space-y-1">
              {tables.map((meta) => (
                <button
                  key={meta.name}
                  onClick={() => setExplorerTable(meta.name)}
                  className={`w-full text-left px-2.5 py-2 rounded-md transition-colors ${
                    explorerTable === meta.name
                      ? "bg-pine-600 dark:bg-pine-500 text-white"
                      : "hover:bg-surface-elevated text-text-primary"
                  }`}
                >
                  <div className="text-sm font-medium">{meta.name}</div>
                  <div
                    className={`text-xs ${
                      explorerTable === meta.name ? "text-white/85" : "text-text-muted"
                    }`}
                  >
                    {meta.row_count.toLocaleString()} rows
                  </div>
                  <div
                    className={`text-[11px] ${
                      explorerTable === meta.name ? "text-white/75" : "text-text-muted"
                    }`}
                  >
                    {formatDateTime(meta.last_changed_at)}
                  </div>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section className="bg-surface border border-border rounded-xl p-4 min-h-[520px]">
          {tab === "explorer" ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2 mb-4">
                <input
                  value={rowSearch}
                  onChange={(event) => setRowSearch(event.target.value)}
                  placeholder="Filter rows..."
                  className="lg:col-span-2 px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500"
                />
                <input
                  type="date"
                  value={rowFrom}
                  onChange={(event) => setRowFrom(event.target.value)}
                  className="px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
                />
                <input
                  type="date"
                  value={rowTo}
                  onChange={(event) => setRowTo(event.target.value)}
                  className="px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
                />
                <select
                  value={rowSort}
                  onChange={(event) => setRowSort(event.target.value)}
                  className="px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
                >
                  <option value="">Default sort</option>
                  {sortColumns.map((column) => (
                    <option key={column} value={column}>
                      Sort: {column}
                    </option>
                  ))}
                </select>
                <div className="flex gap-2">
                  <select
                    value={rowOrder}
                    onChange={(event) => setRowOrder(event.target.value === "asc" ? "asc" : "desc")}
                    className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
                  >
                    <option value="desc">Desc</option>
                    <option value="asc">Asc</option>
                  </select>
                  <button
                    onClick={() => void loadRows()}
                    className="px-3 py-2 rounded-lg bg-surface-elevated border border-border text-sm font-medium hover:bg-border transition-colors"
                  >
                    Refresh
                  </button>
                </div>
              </div>

              {loadingRows ? (
                <div className="text-sm text-text-muted py-12 text-center">Loading rows...</div>
              ) : rows.length === 0 ? (
                <div className="text-sm text-text-muted py-12 text-center">
                  No rows for current filters.
                </div>
              ) : (
                <>
                  <div className="overflow-auto border border-border rounded-lg">
                    <table className="min-w-full text-sm">
                      <thead className="bg-surface-elevated">
                        <tr>
                          {selectedColumns.map((column) => (
                            <th
                              key={column.name}
                              className="text-left px-3 py-2 border-b border-border font-semibold text-text-primary whitespace-nowrap"
                            >
                              {column.name}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row, idx) => (
                          <tr
                            key={idx}
                            className="hover:bg-surface-elevated cursor-pointer"
                            onClick={() => setSelectedRow(row)}
                          >
                            {selectedColumns.map((column) => (
                              <td
                                key={column.name}
                                className="px-3 py-2 border-b border-border align-top text-text-muted max-w-[280px] truncate"
                                title={stringifyCell(row[column.name])}
                              >
                                {stringifyCell(row[column.name])}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {totalRowPages > 1 && (
                    <div className="flex items-center justify-center gap-4 mt-4">
                      <button
                        onClick={() => setRowPage((prev) => Math.max(prev - 1, 0))}
                        disabled={rowPage === 0}
                        className="px-3 py-1.5 rounded-md border border-border bg-surface-elevated text-sm disabled:opacity-40"
                      >
                        Previous
                      </button>
                      <span className="text-sm text-text-muted">
                        Page {rowPage + 1} of {totalRowPages}
                      </span>
                      <button
                        onClick={() => setRowPage((prev) => Math.min(prev + 1, totalRowPages - 1))}
                        disabled={rowPage >= totalRowPages - 1}
                        className="px-3 py-1.5 rounded-md border border-border bg-surface-elevated text-sm disabled:opacity-40"
                      >
                        Next
                      </button>
                    </div>
                  )}
                </>
              )}

              {selectedRow && (
                <div className="mt-4 border border-border rounded-lg">
                  <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-surface-elevated">
                    <h3 className="text-sm font-semibold text-text-primary">Row JSON</h3>
                    <div className="flex gap-2">
                      {selectedRowLinks.map((item) => (
                        <Link
                          key={item.to}
                          to={item.to}
                          className="px-2 py-1 rounded-md text-xs border border-border hover:bg-border"
                        >
                          {item.label}
                        </Link>
                      ))}
                      <button
                        onClick={() => {
                          void navigator.clipboard.writeText(
                            JSON.stringify(selectedRow, null, 2)
                          );
                        }}
                        className="px-2 py-1 rounded-md text-xs border border-border hover:bg-border"
                      >
                        Copy
                      </button>
                      <button
                        onClick={() => setSelectedRow(null)}
                        className="px-2 py-1 rounded-md text-xs border border-border hover:bg-border"
                      >
                        Close
                      </button>
                    </div>
                  </div>
                  <pre className="text-xs p-3 overflow-auto max-h-72 text-text-muted">
                    {JSON.stringify(selectedRow, null, 2)}
                  </pre>
                </div>
              )}
            </>
          ) : (
            <>
              <div className="flex flex-wrap gap-2 mb-4">
                <select
                  value={changeTableFilter ?? ""}
                  onChange={(event) => {
                    const next = event.target.value;
                    setChangeTableFilter(isObservableDbTableName(next) ? next : null);
                  }}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-surface-elevated text-text-muted border border-border"
                >
                  <option value="">All tables</option>
                  {tables.map((meta) => (
                    <option key={meta.name} value={meta.name}>
                      {meta.name}
                    </option>
                  ))}
                </select>
                {CHANGE_WINDOWS.map((window) => (
                  <button
                    key={window.label}
                    onClick={() => setChangeWindowMinutes(window.minutes)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                      changeWindowMinutes === window.minutes
                        ? "bg-pine-600 dark:bg-pine-500 text-white"
                        : "bg-surface-elevated text-text-muted hover:text-text-primary hover:bg-border"
                    }`}
                  >
                    {window.label}
                  </button>
                ))}
                {(["", "insert", "update", "delete", "tool_call"] as const).map((op) => (
                  <button
                    key={op || "all"}
                    onClick={() => setChangeOperation(op)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
                      changeOperation === op
                        ? "bg-pine-600 dark:bg-pine-500 text-white"
                        : "bg-surface-elevated text-text-muted hover:text-text-primary hover:bg-border"
                    }`}
                  >
                    {op || "all"}
                  </button>
                ))}
                <button
                  onClick={() => setChangePaused((paused) => !paused)}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-surface-elevated text-text-muted hover:text-text-primary hover:bg-border"
                >
                  {changePaused ? "Resume" : "Pause"}
                </button>
                <button
                  onClick={() => void loadChanges()}
                  className="px-3 py-1.5 rounded-full text-xs font-medium bg-surface-elevated text-text-muted hover:text-text-primary hover:bg-border"
                >
                  Refresh
                </button>
              </div>

              {loadingChanges ? (
                <div className="text-sm text-text-muted py-12 text-center">
                  Loading changes...
                </div>
              ) : changes.length === 0 ? (
                <div className="text-sm text-text-muted py-12 text-center">
                  No change events in this window.
                </div>
              ) : (
                <div className="space-y-2">
                  {changes.map((change, idx) => {
                    const key = `${change.changed_at}-${change.table}-${change.row_id ?? "null"}-${idx}`;
                    const expanded = Boolean(expandedChangeKeys[key]);
                    const hasPayload = Boolean(change.before || change.after);
                    return (
                      <div key={key} className="border border-border rounded-lg p-3">
                        <div className="flex flex-wrap items-center gap-2 mb-1">
                          <span className="text-xs font-semibold uppercase tracking-wide text-text-primary">
                            {change.operation}
                          </span>
                          <span className="text-xs px-2 py-0.5 rounded-full bg-surface-elevated text-text-muted">
                            {change.table}
                          </span>
                          <span className="text-xs text-text-muted">
                            {new Date(change.changed_at).toLocaleString()}
                          </span>
                        </div>

                        <div className="text-sm text-text-primary">{change.summary}</div>

                        {change.changed_fields && change.changed_fields.length > 0 && (
                          <div className="text-xs text-text-muted mt-1">
                            {change.changed_fields.map((field) => (
                              <span key={field.field} className="inline-flex mr-2">
                                {field.field}: {stringifyCompact(field.before)} -&gt; {stringifyCompact(field.after)}
                              </span>
                            ))}
                          </div>
                        )}

                        <div className="text-xs text-text-muted mt-1">
                          row: {change.row_id ?? "n/a"}
                          {change.tool_name ? ` · tool: ${change.tool_name}` : ""}
                          {change.chat_id ? ` · chat: ${change.chat_id}` : ""}
                        </div>

                        {hasPayload && (
                          <div className="mt-2">
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedChangeKeys((prev) => ({
                                  ...prev,
                                  [key]: !expanded,
                                }))
                              }
                              className="px-2 py-1 rounded-md text-xs border border-border hover:bg-border"
                            >
                              {expanded ? "Hide details" : "Show details"}
                            </button>
                          </div>
                        )}

                        {expanded && hasPayload && (
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mt-2">
                            <div className="border border-border rounded-md">
                              <div className="px-2 py-1 text-xs font-semibold border-b border-border bg-surface-elevated text-text-primary">
                                Before
                              </div>
                              <pre className="text-xs p-2 overflow-auto max-h-56 text-text-muted">
                                {JSON.stringify(change.before ?? null, null, 2)}
                              </pre>
                            </div>
                            <div className="border border-border rounded-md">
                              <div className="px-2 py-1 text-xs font-semibold border-b border-border bg-surface-elevated text-text-primary">
                                After
                              </div>
                              <pre className="text-xs p-2 overflow-auto max-h-56 text-text-muted">
                                {JSON.stringify(change.after ?? null, null, 2)}
                              </pre>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
