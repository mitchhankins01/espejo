export type MetricPoint = { day: string; value: number };

export function linearTrend(points: MetricPoint[]): "improving" | "stable" | "declining" {
  if (points.length < 3) return "stable";
  const first = points[0].value;
  const last = points[points.length - 1].value;
  const delta = last - first;
  if (delta > 2) return "improving";
  if (delta < -2) return "declining";
  return "stable";
}

export function rollingAverage(points: MetricPoint[], window = 7): MetricPoint[] {
  return points.map((point, idx) => {
    const start = Math.max(0, idx - window + 1);
    const slice = points.slice(start, idx + 1);
    const value = slice.reduce((sum, p) => sum + p.value, 0) / slice.length;
    return { day: point.day, value };
  });
}

export function pearsonCorrelation(x: number[], y: number[]): number {
  if (x.length !== y.length || x.length < 3) return 0;
  const meanX = x.reduce((a, b) => a + b, 0) / x.length;
  const meanY = y.reduce((a, b) => a + b, 0) / y.length;
  let num = 0;
  let denX = 0;
  let denY = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i] - meanX;
    const dy = y[i] - meanY;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den === 0 ? 0 : num / den;
}
