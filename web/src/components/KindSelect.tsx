const KINDS = ["insight", "theory", "model", "reference"] as const;

export function KindSelect({
  id,
  value,
  onChange,
}: {
  id?: string;
  value: string;
  onChange: (kind: string) => void;
}) {
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text-primary focus:outline-none focus:ring-2 focus:ring-pine-500/30 focus:border-pine-500 text-base"
    >
      {KINDS.map((k) => (
        <option key={k} value={k}>
          {k.charAt(0).toUpperCase() + k.slice(1)}
        </option>
      ))}
    </select>
  );
}
