import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteWeight,
  getWeightPatterns,
  listWeights,
  upsertWeight,
  type WeightEntry,
  type WeightPatterns,
} from "../api.ts";

type RangeKey = "30d" | "90d" | "365d" | "all";

const RANGE_OPTIONS: Array<{ key: RangeKey; label: string }> = [
  { key: "30d", label: "30d" },
  { key: "90d", label: "90d" },
  { key: "365d", label: "365d" },
  { key: "all", label: "All" },
];

function todayIso(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

function toIsoDay(value: string): string {
  return value.slice(0, 10);
}

function formatSignedKg(value: number | null): string {
  if (value === null) return "N/A";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)} kg`;
}

function formatKg(value: number | null): string {
  if (value === null) return "N/A";
  return `${value.toFixed(2)} kg`;
}

function formatPercent(value: number | null): string {
  if (value === null) return "N/A";
  return `${(value * 100).toFixed(1)}%`;
}

function rangeBounds(range: RangeKey): { from?: string; to?: string } {
  if (range === "all") return {};
  const days = range === "30d" ? 30 : range === "90d" ? 90 : 365;
  const today = new Date();
  const from = new Date(today);
  from.setDate(today.getDate() - (days - 1));

  const toLocalIso = (value: Date): string => {
    const local = new Date(value.getTime() - value.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 10);
  };

  return {
    from: toLocalIso(from),
    to: toLocalIso(today),
  };
}

function rollingAverage(points: WeightEntry[], windowSize: number): Array<number | null> {
  return points.map((_, idx) => {
    if (idx < windowSize - 1) return null;
    const subset = points.slice(idx - windowSize + 1, idx + 1);
    const sum = subset.reduce((acc, item) => acc + item.weight_kg, 0);
    return sum / windowSize;
  });
}

function valueRange(values: number[]): { min: number; max: number } {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return { min: min - 1, max: max + 1 };
  const pad = (max - min) * 0.1;
  return { min: min - pad, max: max + pad };
}

export function Weight() {
  const [entries, setEntries] = useState<WeightEntry[]>([]);
  const [patterns, setPatterns] = useState<WeightPatterns | null>(null);
  const [range, setRange] = useState<RangeKey>("90d");
  const [dateInput, setDateInput] = useState(todayIso());
  const [weightInput, setWeightInput] = useState("");
  const [editingDate, setEditingDate] = useState<string | null>(null);
  const [editingWeight, setEditingWeight] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const bounds = rangeBounds(range);
      const [history, summary] = await Promise.all([
        listWeights({ ...bounds, limit: 1000, offset: 0 }),
        getWeightPatterns(bounds),
      ]);
      setEntries(history.items);
      setPatterns(summary);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => {
    void load();
  }, [load]);

  const pointsAsc = useMemo(
    () =>
      [...entries]
        .sort(
          (a, b) =>
            new Date(a.date).getTime() - new Date(b.date).getTime()
        )
        .map((item) => ({
          ...item,
          date: toIsoDay(item.date),
        })),
    [entries]
  );

  const avg7 = useMemo(() => rollingAverage(pointsAsc, 7), [pointsAsc]);
  const avg30 = useMemo(() => rollingAverage(pointsAsc, 30), [pointsAsc]);

  async function handleSave(date: string, weight: string): Promise<void> {
    const parsed = Number(weight);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError("Enter a valid positive weight value.");
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await upsertWeight(date, parsed);
      setSuccess(`Saved ${parsed.toFixed(2)} kg for ${date}.`);
      setWeightInput("");
      setEditingDate(null);
      setEditingWeight("");
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(date: string): Promise<void> {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      await deleteWeight(date);
      setSuccess(`Deleted weight entry for ${date}.`);
      if (editingDate === date) {
        setEditingDate(null);
        setEditingWeight("");
      }
      await load();
    } catch (err) {
      setError(String(err));
    } finally {
      setSaving(false);
    }
  }

  const chartValues = [
    ...pointsAsc.map((p) => p.weight_kg),
    ...avg7.filter((v): v is number => v !== null),
    ...avg30.filter((v): v is number => v !== null),
  ];

  const chart = useMemo(() => {
    if (pointsAsc.length === 0) return null;
    const width = 900;
    const height = 260;
    const padding = 24;
    const xMin = new Date(pointsAsc[0].date).getTime();
    const xMax = new Date(pointsAsc[pointsAsc.length - 1].date).getTime();
    const yRange = valueRange(chartValues);

    const x = (ts: number): number => {
      if (xMin === xMax) return width / 2;
      const ratio = (ts - xMin) / (xMax - xMin);
      return padding + ratio * (width - padding * 2);
    };
    const y = (value: number): number => {
      const ratio = (value - yRange.min) / (yRange.max - yRange.min);
      return height - padding - ratio * (height - padding * 2);
    };

    const linePath = (values: Array<number | null>, source: WeightEntry[]): string => {
      let path = "";
      for (let i = 0; i < values.length; i++) {
        const value = values[i];
        if (value === null) continue;
        const px = x(new Date(source[i].date).getTime());
        const py = y(value);
        path += path === "" ? `M ${px} ${py}` : ` L ${px} ${py}`;
      }
      return path;
    };

    return {
      width,
      height,
      rawPath: linePath(pointsAsc.map((p) => p.weight_kg), pointsAsc),
      avg7Path: linePath(avg7, pointsAsc),
      avg30Path: linePath(avg30, pointsAsc),
      points: pointsAsc.map((p) => ({
        x: x(new Date(p.date).getTime()),
        y: y(p.weight_kg),
        label: `${p.date} - ${p.weight_kg.toFixed(2)} kg`,
      })),
    };
  }, [avg30, avg7, chartValues, pointsAsc]);

  return (
    <div className="max-w-5xl mx-auto px-4 py-8 pb-16">
      <h1 className="text-xl font-semibold text-text-primary mb-6">Weight</h1>

      <div className="bg-surface rounded-xl border border-border p-4 mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-3 uppercase tracking-wide">
          Quick Log
        </h2>
        <div className="flex flex-col sm:flex-row gap-3">
          <input
            type="date"
            value={dateInput}
            onChange={(e) => setDateInput(e.target.value)}
            className="px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
          />
          <input
            type="number"
            step="0.1"
            min="0"
            value={weightInput}
            onChange={(e) => setWeightInput(e.target.value)}
            placeholder="Weight (kg)"
            className="px-3 py-2 rounded-lg border border-border bg-surface text-text-primary"
          />
          <button
            onClick={() => void handleSave(dateInput, weightInput)}
            disabled={saving}
            className="px-4 py-2 rounded-lg bg-pine-600 dark:bg-pine-500 text-white font-medium disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save"}
          </button>
        </div>
      </div>

      <div className="flex gap-2 mb-4 flex-wrap">
        {RANGE_OPTIONS.map((opt) => (
          <button
            key={opt.key}
            onClick={() => setRange(opt.key)}
            className={`px-3.5 py-1.5 rounded-full text-sm font-medium transition-colors ${
              range === opt.key
                ? "bg-pine-600 dark:bg-pine-500 text-white shadow-sm"
                : "bg-surface-elevated text-text-muted hover:text-text-primary hover:bg-border"
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="text-red-600 dark:text-red-400 text-sm bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg px-4 py-3 mb-4">
          {error}
        </div>
      )}
      {success && (
        <div className="text-pine-700 dark:text-pine-300 text-sm bg-pine-50 dark:bg-pine-950/30 border border-pine-200 dark:border-pine-800 rounded-lg px-4 py-3 mb-4">
          {success}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-xs text-text-muted uppercase tracking-wide mb-1">7d Change</p>
          <p className="text-lg font-semibold">{formatSignedKg(patterns?.delta_7d ?? null)}</p>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-xs text-text-muted uppercase tracking-wide mb-1">30d Change</p>
          <p className="text-lg font-semibold">{formatSignedKg(patterns?.delta_30d ?? null)}</p>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Weekly Pace</p>
          <p className="text-lg font-semibold">{formatSignedKg(patterns?.weekly_pace_kg ?? null)}</p>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Consistency</p>
          <p className="text-lg font-semibold">{formatPercent(patterns?.consistency ?? null)}</p>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Streak</p>
          <p className="text-lg font-semibold">
            {patterns ? `${patterns.streak_days} day${patterns.streak_days === 1 ? "" : "s"}` : "N/A"}
          </p>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Volatility (14)</p>
          <p className="text-lg font-semibold">{formatKg(patterns?.volatility_14d ?? null)}</p>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Plateau</p>
          <p className="text-lg font-semibold">{patterns ? (patterns.plateau ? "Yes" : "No") : "N/A"}</p>
        </div>
        <div className="bg-surface rounded-xl border border-border p-4">
          <p className="text-xs text-text-muted uppercase tracking-wide mb-1">Latest</p>
          <p className="text-lg font-semibold">
            {patterns?.latest ? `${patterns.latest.weight_kg.toFixed(2)} kg` : "N/A"}
          </p>
          {patterns?.latest && (
            <p className="text-xs text-text-muted mt-1">{patterns.latest.date}</p>
          )}
        </div>
      </div>

      <div className="bg-surface rounded-xl border border-border p-4 mb-6">
        <h2 className="text-sm font-semibold text-text-primary mb-3 uppercase tracking-wide">
          Trend
        </h2>
        {chart ? (
          <svg
            viewBox={`0 0 ${chart.width} ${chart.height}`}
            className="w-full h-64"
            role="img"
            aria-label="Weight trend chart"
          >
            <path d={chart.rawPath} fill="none" stroke="var(--color-pine-500)" strokeWidth="2" />
            <path d={chart.avg7Path} fill="none" stroke="#2563eb" strokeWidth="2" />
            <path d={chart.avg30Path} fill="none" stroke="#f59e0b" strokeWidth="2" strokeDasharray="6 4" />
            {chart.points.map((point, idx) => (
              <circle key={idx} cx={point.x} cy={point.y} r="3.5" fill="var(--color-pine-600)">
                <title>{point.label}</title>
              </circle>
            ))}
          </svg>
        ) : (
          <div className="text-text-muted text-sm py-12 text-center">
            No weight data in this range.
          </div>
        )}
        <div className="flex flex-wrap gap-3 mt-2 text-xs text-text-muted">
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-[2px] bg-pine-500 inline-block" />
            Raw
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-[2px] bg-blue-600 inline-block" />
            7-point avg
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="w-3 h-[2px] bg-amber-500 inline-block" />
            30-point avg
          </span>
        </div>
      </div>

      <div className="bg-surface rounded-xl border border-border overflow-hidden">
        <h2 className="text-sm font-semibold text-text-primary p-4 border-b border-border uppercase tracking-wide">
          History
        </h2>
        {loading ? (
          <div className="p-6 text-center text-text-muted">Loading...</div>
        ) : entries.length === 0 ? (
          <div className="p-6 text-center text-text-muted">No entries in this range.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="bg-surface-elevated text-text-muted">
                  <th className="text-left px-4 py-2 font-medium">Date</th>
                  <th className="text-left px-4 py-2 font-medium">Weight</th>
                  <th className="text-left px-4 py-2 font-medium">Delta</th>
                  <th className="text-right px-4 py-2 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry, idx) => {
                  const date = toIsoDay(entry.date);
                  const next = entries[idx + 1];
                  const delta = next ? entry.weight_kg - next.weight_kg : null;
                  const editing = editingDate === date;

                  return (
                    <tr key={date} className="border-t border-border">
                      <td className="px-4 py-2 text-text-primary">{date}</td>
                      <td className="px-4 py-2 text-text-primary">
                        {editing ? (
                          <input
                            type="number"
                            step="0.1"
                            min="0"
                            value={editingWeight}
                            onChange={(e) => setEditingWeight(e.target.value)}
                            className="w-28 px-2 py-1 rounded border border-border bg-surface"
                          />
                        ) : (
                          `${entry.weight_kg.toFixed(2)} kg`
                        )}
                      </td>
                      <td className="px-4 py-2 text-text-muted">{formatSignedKg(delta)}</td>
                      <td className="px-4 py-2">
                        <div className="flex justify-end gap-2">
                          {editing ? (
                            <>
                              <button
                                onClick={() => void handleSave(date, editingWeight)}
                                disabled={saving}
                                className="px-2.5 py-1 rounded bg-pine-600 dark:bg-pine-500 text-white text-xs font-medium disabled:opacity-50"
                              >
                                Save
                              </button>
                              <button
                                onClick={() => {
                                  setEditingDate(null);
                                  setEditingWeight("");
                                }}
                                className="px-2.5 py-1 rounded bg-surface-elevated text-text-primary text-xs font-medium"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              onClick={() => {
                                setEditingDate(date);
                                setEditingWeight(entry.weight_kg.toFixed(2));
                              }}
                              className="px-2.5 py-1 rounded bg-surface-elevated text-text-primary text-xs font-medium"
                            >
                              Edit
                            </button>
                          )}
                          <button
                            onClick={() => void handleDelete(date)}
                            disabled={saving}
                            className="px-2.5 py-1 rounded bg-red-600 text-white text-xs font-medium disabled:opacity-50"
                          >
                            Delete
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
