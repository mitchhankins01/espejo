import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listDbTables,
  listDbTableRows,
  listDbChanges,
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

type DbTab = "explorer" | "changes";

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

export function DbObservability() {
  const [tables, setTables] = useState<DbTableMeta[]>([]);
  const [table, setTable] = useState<ObservableDbTableName | null>(null);
  const [tab, setTab] = useState<DbTab>("explorer");
  const [rows, setRows] = useState<Record<string, unknown>[]>([]);
  const [columns, setColumns] = useState<DbColumnMeta[]>([]);
  const [rowsTotal, setRowsTotal] = useState(0);
  const [rowPage, setRowPage] = useState(0);
  const [rowSearch, setRowSearch] = useState("");
  const [selectedRow, setSelectedRow] = useState<Record<string, unknown> | null>(null);
  const [changes, setChanges] = useState<DbChangeEvent[]>([]);
  const [changeOperation, setChangeOperation] = useState<DbChangeOperation | "">("");
  const [changeWindowMinutes, setChangeWindowMinutes] = useState<number>(60);
  const [changePaused, setChangePaused] = useState(false);
  const [loadingTables, setLoadingTables] = useState(true);
  const [loadingRows, setLoadingRows] = useState(false);
  const [loadingChanges, setLoadingChanges] = useState(false);
  const [error, setError] = useState("");

  const totalRowPages = Math.ceil(rowsTotal / PAGE_SIZE);

  const selectedColumns = useMemo(
    () => columns.filter((column) => !column.hidden),
    [columns]
  );

  const loadTables = useCallback(async (): Promise<void> => {
    setLoadingTables(true);
    setError("");
    try {
      const metas = await listDbTables();
      setTables(metas);
      if (!table && metas[0]) {
        setTable(metas[0].name);
      }
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingTables(false);
    }
  }, [table]);

  const loadRows = useCallback(async (): Promise<void> => {
    if (!table) return;
    setLoadingRows(true);
    setError("");
    try {
      const result = await listDbTableRows(table, {
        limit: PAGE_SIZE,
        offset: rowPage * PAGE_SIZE,
        q: rowSearch.trim() || undefined,
      });
      setRows(result.items);
      setRowsTotal(result.total);
      setColumns(result.columns);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingRows(false);
    }
  }, [rowPage, rowSearch, table]);

  const loadChanges = useCallback(async (): Promise<void> => {
    setLoadingChanges(true);
    setError("");
    try {
      const since = new Date(Date.now() - changeWindowMinutes * 60_000).toISOString();
      const result = await listDbChanges({
        limit: 200,
        since,
        table: table ?? undefined,
        operation: changeOperation || undefined,
      });
      setChanges(result);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoadingChanges(false);
    }
  }, [changeOperation, changeWindowMinutes, table]);

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
  }, [table, rowSearch]);

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
                  onClick={() => setTable(meta.name)}
                  className={`w-full text-left px-2.5 py-2 rounded-md transition-colors ${
                    table === meta.name
                      ? "bg-pine-600 dark:bg-pine-500 text-white"
                      : "hover:bg-surface-elevated text-text-primary"
                  }`}
                >
                  <div className="text-sm font-medium">{meta.name}</div>
                  <div
                    className={`text-xs ${
                      table === meta.name ? "text-white/85" : "text-text-muted"
                    }`}
                  >
                    {meta.row_count.toLocaleString()} rows
                  </div>
                  <div
                    className={`text-[11px] ${
                      table === meta.name ? "text-white/75" : "text-text-muted"
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
              <div className="flex gap-2 mb-4">
                <input
                  value={rowSearch}
                  onChange={(event) => setRowSearch(event.target.value)}
                  placeholder="Filter rows..."
                  className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary placeholder:text-text-muted/60 focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500"
                />
                <button
                  onClick={() => void loadRows()}
                  className="px-3 py-2 rounded-lg bg-surface-elevated border border-border text-sm font-medium hover:bg-border transition-colors"
                >
                  Refresh
                </button>
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
                  {changes.map((change, idx) => (
                    <div
                      key={`${change.changed_at}-${change.table}-${change.row_id ?? "null"}-${idx}`}
                      className="border border-border rounded-lg p-3"
                    >
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
                      <div className="text-xs text-text-muted mt-1">
                        row: {change.row_id ?? "n/a"}
                        {change.tool_name ? ` · tool: ${change.tool_name}` : ""}
                        {change.chat_id ? ` · chat: ${change.chat_id}` : ""}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
