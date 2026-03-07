const KINDS = ["insight", "theory", "model", "reference"] as const;

export function KindSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (kind: string) => void;
}) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      {KINDS.map((k) => (
        <option key={k} value={k}>
          {k.charAt(0).toUpperCase() + k.slice(1)}
        </option>
      ))}
    </select>
  );
}
