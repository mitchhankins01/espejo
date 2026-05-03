import type pg from "pg";

export interface ScreenTimeAppMinutes {
  app: string;
  minutes: number;
}

export interface ScreenTimeCategoryMinutes {
  name: string;
  minutes: number;
}

export interface ScreenTimeAppCount {
  app: string;
  count: number;
}

export interface DailyScreenTimeRow {
  date: string;
  total_minutes: number;
  categories: ScreenTimeCategoryMinutes[];
  apps: ScreenTimeAppMinutes[];
  pickups: number | null;
  first_pickup: string | null;
  pickup_apps: ScreenTimeAppCount[] | null;
  notifications: number | null;
  notification_apps: ScreenTimeAppCount[] | null;
  source_message_id: number | null;
  raw_text: string | null;
  ingested_at: Date;
}

export interface UpsertDailyScreenTimeInput {
  date: string;
  totalMinutes: number;
  categories: ScreenTimeCategoryMinutes[];
  apps: ScreenTimeAppMinutes[];
  pickups?: number | null;
  firstPickup?: string | null;
  pickupApps?: ScreenTimeAppCount[] | null;
  notifications?: number | null;
  notificationApps?: ScreenTimeAppCount[] | null;
  sourceMessageId?: number | null;
  rawText?: string | null;
}

export async function upsertDailyScreenTime(
  pool: pg.Pool,
  input: UpsertDailyScreenTimeInput
): Promise<DailyScreenTimeRow> {
  const result = await pool.query(
    `INSERT INTO daily_screen_time
       (date, total_minutes, categories, apps, pickups, first_pickup,
        pickup_apps, notifications, notification_apps, source_message_id, raw_text)
     VALUES
       ($1::date, $2, $3::jsonb, $4::jsonb, $5, $6::time, $7::jsonb, $8, $9::jsonb, $10, $11)
     ON CONFLICT (date) DO UPDATE SET
       total_minutes = EXCLUDED.total_minutes,
       categories = EXCLUDED.categories,
       apps = EXCLUDED.apps,
       pickups = EXCLUDED.pickups,
       first_pickup = EXCLUDED.first_pickup,
       pickup_apps = EXCLUDED.pickup_apps,
       notifications = EXCLUDED.notifications,
       notification_apps = EXCLUDED.notification_apps,
       source_message_id = EXCLUDED.source_message_id,
       raw_text = EXCLUDED.raw_text,
       ingested_at = NOW()
     RETURNING date, total_minutes, categories, apps, pickups, first_pickup,
               pickup_apps, notifications, notification_apps,
               source_message_id, raw_text, ingested_at`,
    [
      input.date,
      input.totalMinutes,
      JSON.stringify(input.categories),
      JSON.stringify(input.apps),
      input.pickups ?? null,
      input.firstPickup ?? null,
      input.pickupApps == null ? null : JSON.stringify(input.pickupApps),
      input.notifications ?? null,
      input.notificationApps == null ? null : JSON.stringify(input.notificationApps),
      input.sourceMessageId ?? null,
      input.rawText ?? null,
    ]
  );
  return parseRow(result.rows[0]);
}

export async function getDailyScreenTime(
  pool: pg.Pool,
  date: string
): Promise<DailyScreenTimeRow | null> {
  const result = await pool.query(
    `SELECT date, total_minutes, categories, apps, pickups, first_pickup,
            pickup_apps, notifications, notification_apps,
            source_message_id, raw_text, ingested_at
     FROM daily_screen_time
     WHERE date = $1::date`,
    [date]
  );
  if (result.rows.length === 0) return null;
  return parseRow(result.rows[0]);
}

function dateToIsoDay(value: unknown): string {
  if (value instanceof Date) {
    // pg returns DATE columns as Date at local-midnight, so toISOString can
    // shift the day backwards in negative-offset timezones. Use local
    // components instead.
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, "0");
    const d = String(value.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}

function parseRow(row: Record<string, unknown>): DailyScreenTimeRow {
  return {
    date: dateToIsoDay(row.date),
    total_minutes: Number(row.total_minutes),
    categories: (row.categories as ScreenTimeCategoryMinutes[]) ?? [],
    apps: (row.apps as ScreenTimeAppMinutes[]) ?? [],
    pickups: row.pickups == null ? null : Number(row.pickups),
    first_pickup: row.first_pickup == null ? null : String(row.first_pickup),
    pickup_apps: (row.pickup_apps as ScreenTimeAppCount[] | null) ?? null,
    notifications:
      row.notifications == null ? null : Number(row.notifications),
    notification_apps:
      (row.notification_apps as ScreenTimeAppCount[] | null) ?? null,
    source_message_id:
      row.source_message_id == null ? null : Number(row.source_message_id),
    raw_text: row.raw_text == null ? null : String(row.raw_text),
    ingested_at:
      row.ingested_at instanceof Date
        ? row.ingested_at
        : new Date(String(row.ingested_at)),
  };
}
