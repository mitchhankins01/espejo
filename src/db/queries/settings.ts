import type pg from "pg";

// ============================================================================
// User Settings
// ============================================================================

export interface UserSettingsRow {
  chat_id: string;
  timezone: string;
  checkin_enabled: boolean;
  checkin_morning_hour: number;
  checkin_afternoon_hour: number;
  checkin_evening_hour: number;
  checkin_snooze_until: Date | null;
  updated_at: Date;
}

export async function getUserSettings(
  pool: pg.Pool,
  chatId: string
): Promise<UserSettingsRow | null> {
  const result = await pool.query<UserSettingsRow>(
    "SELECT * FROM user_settings WHERE chat_id = $1",
    [chatId]
  );
  return result.rows[0] ?? null;
}

export async function upsertUserSettings(
  pool: pg.Pool,
  chatId: string,
  data: Partial<Omit<UserSettingsRow, "chat_id" | "updated_at">>
): Promise<UserSettingsRow> {
  // Collect columns and values for both INSERT and UPDATE
  const cols: string[] = ["chat_id"];
  const vals: unknown[] = [chatId];
  const updates: string[] = [];
  let idx = 2;

  const addField = (col: string, val: unknown): void => {
    cols.push(col);
    vals.push(val);
    updates.push(`${col} = $${idx}`);
    idx++;
  };

  if (data.timezone !== undefined) addField("timezone", data.timezone);
  /* v8 ignore next */ if (data.checkin_enabled !== undefined) addField("checkin_enabled", data.checkin_enabled);
  /* v8 ignore next */ if (data.checkin_morning_hour !== undefined) addField("checkin_morning_hour", data.checkin_morning_hour);
  /* v8 ignore next */ if (data.checkin_afternoon_hour !== undefined) addField("checkin_afternoon_hour", data.checkin_afternoon_hour);
  /* v8 ignore next */ if (data.checkin_evening_hour !== undefined) addField("checkin_evening_hour", data.checkin_evening_hour);
  /* v8 ignore next */ if (data.checkin_snooze_until !== undefined) addField("checkin_snooze_until", data.checkin_snooze_until);

  const updateClause = updates.length > 0
    ? updates.join(", ") + ", updated_at = NOW()"
    : "updated_at = NOW()";

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");

  const result = await pool.query<UserSettingsRow>(
    `INSERT INTO user_settings (${cols.join(", ")})
     VALUES (${placeholders})
     ON CONFLICT (chat_id) DO UPDATE SET ${updateClause}
     RETURNING *`,
    vals
  );
  return result.rows[0];
}
