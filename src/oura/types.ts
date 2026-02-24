export interface OuraApiListResponse<T> {
  data: T[];
  next_token?: string;
}

export interface OuraSyncResult {
  endpoint: string;
  count: number;
  error?: string;
}

export interface OuraDailySummaryRow {
  day: string;
  sleep_score: number | null;
  readiness_score: number | null;
  activity_score: number | null;
  steps: number | null;
  stress: string | null;
  average_hrv: number | null;
  average_heart_rate: number | null;
  sleep_duration_seconds: number | null;
  deep_sleep_duration_seconds: number | null;
  rem_sleep_duration_seconds: number | null;
  efficiency: number | null;
  workout_count: number;
}

export interface OuraTrendPoint {
  day: string;
  value: number;
}
