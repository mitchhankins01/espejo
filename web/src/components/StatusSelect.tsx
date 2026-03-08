const STATUSES = ["active", "waiting", "done", "someday"] as const;

export function StatusSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (status: string) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
    >
      {STATUSES.map((status) => (
        <option key={status} value={status}>
          {status.charAt(0).toUpperCase() + status.slice(1)}
        </option>
      ))}
    </select>
  );
}
