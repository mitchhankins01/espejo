/**
 * Evening-review data gatherer.
 *
 * Collects the day's signal from Postgres (prod) + the local Obsidian vault +
 * the Mac WhatsApp SQLite store, and writes a single structured digest to
 *   /tmp/espejo-evening-gather/<DATE>.md
 * Stdout prints per-section status (counts + warnings) and the digest path.
 *
 * This is the deterministic plumbing half of the evening review. The reasoning
 * half lives in Artifacts/Prompt/Review/Evening.md, which calls this script,
 * reads the digest, and conducts the interview. See the council synthesis
 * (2026-05-31) for why the SQL was de-interleaved out of the prompt.
 *
 * Usage:
 *   pnpm gather:evening                 # today (Europe/Madrid), full run
 *   pnpm gather:evening --date 2026-05-30
 *   pnpm gather:evening --no-whatsapp   # skip the Mac WhatsApp pull entirely
 *   pnpm gather:evening --no-transcribe # pull WhatsApp text but don't Whisper voice notes
 *
 * DIGEST CONTRACT (the prompt depends on this):
 *   - FULL-TEXT sections (verbatim, never truncated): #1 Journal, #2 Reviews,
 *     #3 Insights, #12a Telegram self-capture, #15 WhatsApp threads. These are
 *     primary source material — the gatherer must NOT pre-digest them into bullets.
 *   - SHAPE sections (tabular rows for deviation-vs-baseline reading): Oura
 *     (#4/#5/#6), weight (#8), checkpoints (#9), agent prompts (#11),
 *     interaction timeline (#12b), ActivityWatch (#13), screen time (#14).
 *   - Every section is wrapped so a broken query surfaces as `❌ ERROR: …` in
 *     both the digest and stdout, and the run continues. Never fail silently.
 */
import "../src/config.js"; // side-effect: loads .env.production.local when NODE_ENV=production
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename, extname } from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import { pool } from "../src/db/client.js";
import { parseObsidianNote } from "../src/obsidian/parser.js";
import { transcribeAudio } from "../src/llm/transcribe.js";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name: string): boolean {
  return argv.includes(name);
}
function opt(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const SKIP_WA = flag("--no-whatsapp");
const SKIP_TRANSCRIBE = flag("--no-transcribe");

// ── dates (Europe/Madrid) ─────────────────────────────────────────────────────
function madridDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
const TODAY = opt("--date") ?? madridDate(new Date());
const SEVEN_AGO = madridDate(new Date(new Date(`${TODAY}T12:00:00Z`).getTime() - 7 * 86400_000));

// ── digest + status accumulators ──────────────────────────────────────────────
type Status = "ok" | "warn" | "error";
interface SectionLog {
  id: string;
  status: Status;
  note: string;
}
const logs: SectionLog[] = [];
const parts: string[] = [];
function emit(md: string): void {
  parts.push(md);
}

/** Run one section in isolation: a thrown error is captured, never fatal. */
async function section(
  id: string,
  tag: string,
  fn: () => Promise<{ status?: Status; note: string }>
): Promise<void> {
  emit(`\n## ${id}  _${tag}_\n`);
  try {
    const r = await fn();
    logs.push({ id, status: r.status ?? "ok", note: r.note });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    emit(`> ❌ ERROR: ${msg}\n`);
    logs.push({ id, status: "error", note: msg });
  }
}

// ── rendering helpers ─────────────────────────────────────────────────────────
function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  // Date-valued columns are day buckets (pg `date`, parsed by node-pg as local
  // midnight). Render the Madrid calendar date, not an ISO timestamp that reads
  // as the prior day in UTC.
  if (v instanceof Date) return madridDate(v);
  // jsonb columns (e.g. screen-time apps_10min/cats) arrive as parsed objects/arrays.
  if (typeof v === "object") return JSON.stringify(v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
  return String(v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
}
function mdTable(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "_(no rows)_\n";
  const cols = Object.keys(rows[0]);
  const head = `| ${cols.join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${cols.map((c) => fmtCell(r[c])).join(" | ")} |`).join("\n");
  return `${head}\n${sep}\n${body}\n`;
}
async function q(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  const res = await pool.query(sql, params);
  return res.rows as Record<string, unknown>[];
}

// ── vault helpers ─────────────────────────────────────────────────────────────
function listMd(dir: string): string[] {
  const abs = join(process.cwd(), dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs)
    .filter((f) => f.endsWith(".md"))
    .map((f) => join(abs, f));
}

// ── prior-review boundary (shared by #9a and #15) ─────────────────────────────
// The created_at of the most recent Evening Checkin that is NOT today's. Late
// tolls / late-night WhatsApp logged after last night's review wrapped would
// otherwise vanish into yesterday's date bucket.
async function priorReviewBoundary(): Promise<Date | null> {
  const rows = await q(
    `SELECT created_at FROM knowledge_artifacts
     WHERE kind='review' AND title LIKE '% — Evening Checkin' AND title NOT LIKE $1
     ORDER BY created_at DESC LIMIT 1`,
    [`${TODAY}%`]
  );
  return rows.length ? (rows[0].created_at as Date) : null;
}

// ──────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  emit(`# Evening gather — ${TODAY}`);
  emit(`_7-day window starts ${SEVEN_AGO}. Generated by scripts/gather-evening.ts._`);
  emit(
    `\n> **How to read this digest.** FULL-TEXT sections (#1, #2, #3, #12a, #15) are ` +
      `primary source material — quote and weave them, never compress. SHAPE sections are ` +
      `tables: read deviation vs the 7-day baseline, never recite raw numbers. Any ` +
      `\`❌ ERROR\` below is a real failure — surface it, don't gather past it.\n`
  );

  const boundary = await priorReviewBoundary();

  // #1 Journal — FULL-TEXT
  await section("#1 Journal (last 7d)", "FULL-TEXT", async () => {
    const rows = await q(
      `SELECT (created_at AT TIME ZONE 'Europe/Madrid')::date AS day, city, text
       FROM entries WHERE (created_at AT TIME ZONE 'Europe/Madrid')::date >= $1
       ORDER BY created_at DESC`,
      [SEVEN_AGO]
    );
    for (const r of rows) {
      emit(`### ${fmtCell(r.day)}${r.city ? ` — ${fmtCell(r.city)}` : ""}\n\n${r.text ?? ""}\n`);
    }
    if (rows.length === 0) emit("_(no entries — did Mitch run `pnpm sync`?)_\n");
    return { status: rows.length ? "ok" : "warn", note: `${rows.length} entries` };
  });

  // #2 Reviews (last 7d) — FULL-TEXT, filesystem (DB updated_at = sync time, not work time)
  await section("#2 Reviews (last 7d)", "FULL-TEXT", async () => {
    let n = 0;
    for (const f of listMd("Artifacts/Review").sort().reverse()) {
      const m = basename(f).match(/^(\d{4}-\d{2}-\d{2})/);
      if (!m || m[1] < SEVEN_AGO) continue;
      const parsed = parseObsidianNote(readFileSync(f, "utf8"), basename(f));
      emit(`### ${basename(f, ".md")}\n\n${parsed.body}\n`);
      n++;
    }
    return { status: n ? "ok" : "warn", note: `${n} files` };
  });

  // #3 Insights (last 7d) — FULL-TEXT, filesystem frontmatter dates
  await section("#3 Insights (last 7d)", "FULL-TEXT", async () => {
    let n = 0;
    for (const f of listMd("Artifacts/Insight")) {
      const parsed = parseObsidianNote(readFileSync(f, "utf8"), basename(f));
      const c = parsed.createdAt ? madridDate(parsed.createdAt) : "";
      const u = parsed.updatedAt ? madridDate(parsed.updatedAt) : "";
      if (c < SEVEN_AGO && u < SEVEN_AGO) continue;
      emit(`### ${basename(f, ".md")}  (created ${c || "?"}, updated ${u || "?"})\n\n${parsed.body}\n`);
      n++;
    }
    return { status: "ok", note: `${n} touched` };
  });

  // #4 Oura stress/recovery — SHAPE
  await section("#4 Oura stress/recovery (7d)", "SHAPE", async () => {
    const rows = await q(
      `SELECT day, stress_high_seconds, recovery_high_seconds
       FROM oura_daily_stress WHERE day >= $1 ORDER BY day DESC`,
      [SEVEN_AGO]
    );
    emit(mdTable(rows));
    const hasToday = rows.some((r) => fmtCell(r.day) === TODAY);
    return {
      status: hasToday ? "ok" : "warn",
      note: hasToday ? `${rows.length} days` : `${rows.length} days, today missing (open Oura app?)`,
    };
  });

  // #5 Oura sleep/readiness/stages — SHAPE (long_sleep only; day_summary intentionally unused)
  await section("#5 Oura sleep/readiness/stages (7d)", "SHAPE", async () => {
    const rows = await q(
      `SELECT d.day, d.score AS sleep, r.score AS readiness,
              ROUND(ss.total_sleep_duration_seconds/3600.0, 1) AS hours,
              ss.rem_sleep_seconds/60   AS rem_min,
              ss.deep_sleep_seconds/60  AS deep_min,
              ss.light_sleep_seconds/60 AS light_min,
              ss.awake_seconds/60       AS awake_min,
              ss.latency_seconds        AS latency_s,
              ROUND(ss.efficiency::numeric, 0)     AS efficiency,
              ROUND(ss.average_hrv::numeric, 0)    AS hrv,
              ss.lowest_heart_rate                 AS rhr,
              ROUND(ss.average_breath::numeric, 1) AS breath,
              ss.sleep_score_delta                 AS s_delta,
              ss.readiness_score_delta             AS r_delta,
              sp.average_spo2::numeric(4,1)        AS spo2,
              sp.breathing_disturbance_index       AS bdi,
              rs.level                             AS resilience,
              cv.vascular_age                      AS v_age
       FROM oura_daily_sleep d
       LEFT JOIN oura_daily_readiness r ON r.day=d.day
       LEFT JOIN LATERAL (
         SELECT total_sleep_duration_seconds, rem_sleep_seconds, deep_sleep_seconds,
                light_sleep_seconds, awake_seconds, latency_seconds, efficiency,
                average_hrv, average_heart_rate, lowest_heart_rate, average_breath,
                sleep_score_delta, readiness_score_delta
         FROM oura_sleep_sessions
         WHERE day=d.day AND sleep_type='long_sleep' LIMIT 1
       ) ss ON TRUE
       LEFT JOIN oura_daily_spo2 sp ON sp.day=d.day
       LEFT JOIN oura_daily_resilience rs ON rs.day=d.day
       LEFT JOIN oura_daily_cardiovascular_age cv ON cv.day=d.day
       WHERE d.day >= $1 ORDER BY d.day DESC`,
      [SEVEN_AGO]
    );
    emit(mdTable(rows));
    // optimal bedtime (folded in from the cut #7 — single line, only if present)
    const bt = await q(
      `SELECT recommendation, optimal_bedtime FROM oura_sleep_time WHERE day = $1`,
      [TODAY]
    );
    if (bt.length) emit(`\n_Optimal bedtime today: ${fmtCell(bt[0].optimal_bedtime)} (${fmtCell(bt[0].recommendation)})_\n`);
    return { status: rows.length ? "ok" : "warn", note: `${rows.length} nights` };
  });

  // #6 Oura activity / sedentary load — SHAPE
  await section("#6 Oura activity/sedentary (7d)", "SHAPE", async () => {
    const rows = await q(
      `SELECT day, score, steps, active_calories,
              high_met_minutes AS h_met, medium_met_minutes AS m_met,
              (sedentary_seconds/3600.0)::numeric(4,1) AS sed_h,
              (non_wear_seconds/3600.0)::numeric(4,1)  AS off_h,
              inactivity_alerts AS sit_alerts
       FROM oura_daily_activity WHERE day >= $1 ORDER BY day DESC`,
      [SEVEN_AGO]
    );
    emit(mdTable(rows));
    return { status: rows.length ? "ok" : "warn", note: `${rows.length} days` };
  });

  // (#7 Oura tags + meditation — CUT 2026-05-31: zero rows for weeks. optimal_bedtime folded into #5.)

  // #8 Weight — SHAPE
  await section("#8 Weight (7d)", "SHAPE", async () => {
    const rows = await q(
      `SELECT date, weight_kg FROM daily_metrics
       WHERE date >= $1 AND weight_kg IS NOT NULL ORDER BY date DESC`,
      [SEVEN_AGO]
    );
    emit(mdTable(rows));
    return { status: rows.length ? "ok" : "warn", note: `${rows.length} readings` };
  });

  // #9 Checkpoints / tolls — SHAPE (+ #9a post-prior-review tail)
  await section("#9 Checkpoints (7d)", "SHAPE", async () => {
    const rows = await q(
      `SELECT local_date,
              to_char(occurred_at AT TIME ZONE 'Europe/Madrid', 'HH24:MI') AS hhmm,
              kind, trigger, body_signal, part_voice, resolution
       FROM checkpoints WHERE local_date >= $1 ORDER BY occurred_at`,
      [SEVEN_AGO]
    );
    emit(mdTable(rows));
    emit(
      `\n_Convention (2026-05-13): every \`substance\` row is a use; passes happen ` +
        `silently and are never logged. Don't compute pass/go ratios. Read the SHAPE of ` +
        `today vs the prior 6 days — count, time-of-day clustering, which substance, which parts spoke._\n`
    );

    // #9a — tolls logged after the previous review wrapped
    if (boundary) {
      const tail = await q(
        `SELECT to_char(occurred_at AT TIME ZONE 'Europe/Madrid', 'MM-DD HH24:MI') AS when_,
                kind, trigger, body_signal, part_voice
         FROM checkpoints WHERE occurred_at > $1 ORDER BY occurred_at`,
        [boundary]
      );
      if (tail.length) {
        emit(`\n### #9a Post-prior-review tolls (after last review wrapped)\n\n${mdTable(tail)}`);
        emit(`_Name these as a discrete late cluster — they were logged after the day was already closed._\n`);
      }
    }
    return { status: "ok", note: `${rows.length} tolls/7d` };
  });

  // #10 Espejo momentum — SHAPE
  await section("#10 Espejo momentum today", "SHAPE", async () => {
    let commits = "";
    try {
      commits = execFileSync("git", ["log", `--since=${TODAY} 00:00`, "--pretty=format:%h %s"], {
        cwd: process.cwd(),
        encoding: "utf8",
      }).trim();
    } catch (e) {
      commits = `(git log failed: ${e instanceof Error ? e.message : String(e)})`;
    }
    emit(`**Commits today:**\n\n${commits ? "```\n" + commits + "\n```" : "_(none)_"}\n`);

    const touched: string[] = [];
    for (const dir of ["Insight", "Review", "Note", "Project", "Pending"]) {
      for (const f of listMd(`Artifacts/${dir}`)) {
        const p = parseObsidianNote(readFileSync(f, "utf8"), basename(f));
        const c = p.createdAt ? madridDate(p.createdAt) : "";
        const u = p.updatedAt ? madridDate(p.updatedAt) : "";
        if (c === TODAY || u === TODAY) touched.push(`${dir}/${basename(f)}`);
      }
    }
    emit(`\n**Vault files touched today (${touched.length}):**\n\n${touched.length ? touched.map((t) => `- ${t}`).join("\n") : "_(none)_"}\n`);
    return { status: "ok", note: `${commits ? commits.split("\n").length : 0} commits, ${touched.length} files` };
  });

  // #11 Agent chats today — SHAPE (witness against the journal)
  await section("#11 Agent chats today", "SHAPE", async () => {
    const rows = await q(
      `SELECT to_char(started_at AT TIME ZONE 'Europe/Madrid','HH24:MI') AS t,
              surface, category, SUBSTRING(p->>'text' FROM 1 FOR 200) AS prompt
       FROM agent_sessions, jsonb_array_elements(prompts) p
       WHERE (started_at AT TIME ZONE 'Europe/Madrid')::date = $1
         AND p->>'text' NOT LIKE '<local-command-caveat>%'
         AND p->>'text' NOT LIKE '<command-name>%'
       ORDER BY started_at, (p->>'index')::int`,
      [TODAY]
    );
    emit(mdTable(rows));
    return { status: "ok", note: `${rows.length} prompts` };
  });

  // #12a Telegram self-capture — FULL-TEXT, PRIMARY
  await section("#12a Telegram self-capture today", "FULL-TEXT — PRIMARY", async () => {
    const rows = await q(
      `SELECT to_char(created_at AT TIME ZONE 'Europe/Madrid','HH24:MI') AS t, content
       FROM chat_messages
       WHERE (created_at AT TIME ZONE 'Europe/Madrid')::date = $1
         AND role = 'user' AND (flow = 'chat' OR flow IS NULL)
       ORDER BY created_at`,
      [TODAY]
    );
    emit(
      `_Primary source. Every distinct thread here earns integration into the draft in his own ` +
        `framing — a rich self-capture day produces a DENSER body/relational section, not a tidier one._\n`
    );
    for (const r of rows) emit(`**${fmtCell(r.t)}** — ${r.content ?? ""}\n`);
    if (rows.length === 0) emit("_(no self-capture today)_\n");
    return { status: "ok", note: `${rows.length} messages` };
  });

  // #12b Interaction timeline — SHAPE (texture: timing + clustering)
  await section("#12b Interaction timeline today", "SHAPE", async () => {
    const rows = await q(
      `SELECT to_char(created_at AT TIME ZONE 'Europe/Madrid','HH24:MI') AS t,
              COALESCE(flow, '-') AS flow, SUBSTRING(content FROM 1 FOR 200) AS prompt
       FROM chat_messages
       WHERE (created_at AT TIME ZONE 'Europe/Madrid')::date = $1 AND role = 'user'
       ORDER BY created_at`,
      [TODAY]
    );
    emit(mdTable(rows));
    emit(`_Read the clusters (e.g. SRS drills alongside a nicotine cluster), not the list. Full \`chat\` content is in #12a._\n`);
    return { status: "ok", note: `${rows.length} turns` };
  });

  // #13 Mac activity (ActivityWatch) — SHAPE vs 6-day baseline
  await section("#13 Mac activity (ActivityWatch)", "SHAPE", async () => {
    const apps = await q(
      `SELECT app, ROUND(SUM(duration_ms)/60000.0,1) AS min FROM device_events
       WHERE bucket='window' AND (started_at AT TIME ZONE 'Europe/Madrid')::date = $1 AND app IS NOT NULL
       GROUP BY app ORDER BY 2 DESC LIMIT 10`,
      [TODAY]
    );
    const hosts = await q(
      `SELECT hostname, ROUND(SUM(duration_ms)/60000.0,1) AS min FROM device_events
       WHERE bucket='web' AND (started_at AT TIME ZONE 'Europe/Madrid')::date = $1 AND hostname IS NOT NULL
       GROUP BY hostname ORDER BY 2 DESC LIMIT 10`,
      [TODAY]
    );
    const baseline = await q(
      `SELECT app, ROUND(AVG(daily_min),1) AS avg_min FROM (
         SELECT (started_at AT TIME ZONE 'Europe/Madrid')::date AS d, app, SUM(duration_ms)/60000.0 AS daily_min
         FROM device_events
         WHERE bucket='window' AND app IS NOT NULL
           AND (started_at AT TIME ZONE 'Europe/Madrid')::date >= $1
           AND (started_at AT TIME ZONE 'Europe/Madrid')::date <  $2
         GROUP BY 1,2
       ) t GROUP BY app ORDER BY 2 DESC LIMIT 10`,
      [SEVEN_AGO, TODAY]
    );
    emit(`**Top apps today (min):**\n\n${mdTable(apps)}`);
    emit(`\n**Top hostnames today (min):**\n\n${mdTable(hosts)}`);
    emit(`\n**Prior-6-day per-app daily average (baseline):**\n\n${mdTable(baseline)}`);
    const note =
      apps.length === 0 ? "today has 0 AW rows (ingest failed, or a genuinely AW-quiet day — say which)" : `${apps.length} apps`;
    return { status: apps.length ? "ok" : "warn", note };
  });

  // #14 iPhone screen time — SHAPE
  await section("#14 iPhone screen time (7d)", "SHAPE", async () => {
    const rows = await q(
      `SELECT date, total_minutes, pickups, first_pickup,
              jsonb_path_query_array(apps, '$[*] ? (@.minutes >= 10)') AS apps_10min,
              jsonb_path_query_array(categories, '$[*]') AS cats
       FROM daily_screen_time WHERE date >= $1 ORDER BY date DESC`,
      [SEVEN_AGO]
    );
    emit(mdTable(rows));
    const hasToday = rows.some((r) => fmtCell(r.date) === TODAY);
    return {
      status: hasToday ? "ok" : "warn",
      note: hasToday ? `${rows.length} days` : `${rows.length} days, today missing (Mitch hasn't uploaded screenshots yet?)`,
    };
  });

  // #15 WhatsApp since last review — FULL-TEXT threads
  await section("#15 WhatsApp since last review", "FULL-TEXT", async () => {
    if (SKIP_WA) {
      emit("_(skipped: --no-whatsapp)_\n");
      return { status: "warn", note: "skipped (--no-whatsapp)" };
    }
    const waDir = join(homedir(), "Library", "Group Containers", "group.net.whatsapp.WhatsApp.shared");
    const src = join(waDir, "ChatStorage.sqlite");
    if (!existsSync(src)) {
      emit("_(WhatsApp DB not found — is Mac WhatsApp installed and foregrounded?)_\n");
      return { status: "warn", note: "DB not found" };
    }
    // WAL mode: copy all three files before reading or recent writes are invisible.
    const tmp = join("/tmp", "espejo-wa-ChatStorage.sqlite");
    for (const ext of ["", "-wal", "-shm"]) {
      if (existsSync(src + ext)) copyFileSync(src + ext, tmp + ext);
    }
    const db = new Database(tmp, { readonly: true });

    // boundary in Mac absolute time (seconds since 2001-01-01 UTC). Fallback: today local midnight.
    const lastUnix = boundary ? Math.floor(boundary.getTime() / 1000) : Math.floor(new Date(`${TODAY}T00:00:00`).getTime() / 1000);
    const waSince = lastUnix - 978307200;

    // #15a — transcribe NEW voice notes only (cache by media UUID)
    const cacheDir = join(process.cwd(), "Artifacts", "Attachment", "WATranscripts");
    mkdirSync(cacheDir, { recursive: true });
    let transcribed = 0;
    let voiceTotal = 0;
    if (!SKIP_TRANSCRIBE) {
      const voiceRows = db
        .prepare(
          `SELECT mi.ZMEDIALOCALPATH AS path FROM ZWAMESSAGE m
           JOIN ZWAMEDIAITEM mi ON mi.ZMESSAGE = m.Z_PK
           WHERE m.ZMESSAGETYPE = 3 AND m.ZMESSAGEDATE > ?`
        )
        .all(waSince) as { path: string | null }[];
      voiceTotal = voiceRows.length;
      for (const v of voiceRows) {
        if (!v.path) continue;
        const uuid = basename(v.path, extname(v.path));
        const cacheFile = join(cacheDir, `${uuid}.txt`);
        if (existsSync(cacheFile)) continue;
        const srcAudio = join(waDir, "Message", v.path);
        if (!existsSync(srcAudio)) continue;
        try {
          // Whisper rejects .opus by extension though the codec is OGG — pass an .ogg filename.
          const text = await transcribeAudio({
            buffer: readFileSync(srcAudio), // no encoding → Buffer
            filename: `${uuid}.ogg`,
            mimeType: "audio/ogg",
          });
          writeFileSync(cacheFile, text);
          transcribed++;
        } catch (e) {
          // one bad voice note shouldn't sink the section
          emit(`> ⚠ voice note ${uuid} failed to transcribe: ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
    }

    // #15b — threads since the boundary, grouped by partner, chronological.
    // ZPUSHNAME / group-member name fields are base64-encoded junk in the current
    // WhatsApp schema (a privacy change scrambled them), so per-participant sender
    // names are NOT recoverable. Use ZPARTNERNAME (clean for 1:1); group senders
    // collapse to a neutral marker, detected via the @g.us JID.
    const msgs = db
      .prepare(
        `SELECT cs.ZPARTNERNAME AS partner, cs.ZCONTACTJID AS jid,
                strftime('%m-%d %H:%M', datetime(m.ZMESSAGEDATE + 978307200, 'unixepoch', 'localtime')) AS ts,
                m.ZISFROMME AS fromme, m.ZMESSAGETYPE AS mtype,
                COALESCE(m.ZTEXT,'') AS text, COALESCE(mi.ZMEDIALOCALPATH,'') AS media
         FROM ZWAMESSAGE m
         JOIN ZWACHATSESSION cs ON cs.Z_PK = m.ZCHATSESSION
         LEFT JOIN ZWAMEDIAITEM mi ON mi.ZMESSAGE = m.Z_PK
         WHERE m.ZMESSAGEDATE > ?
         ORDER BY cs.ZPARTNERNAME, m.ZMESSAGEDATE`
      )
      .all(waSince) as {
      partner: string | null;
      jid: string | null;
      ts: string;
      fromme: number;
      mtype: number;
      text: string;
      media: string;
    }[];
    db.close();

    emit(
      `_Group participant names are unavailable (encoded in the current WhatsApp schema); ` +
        `in group threads non-Mitch senders show as \`(member)\`. 1:1 threads (Dayana, Miguel, ` +
        `family, friends) — the primary relational signal — are fully named._\n`
    );
    const typeMap: Record<number, string> = { 0: "", 1: "[photo]", 8: "[HEIC]", 15: "[sticker]" };
    let cur = "";
    for (const m of msgs) {
      const partner = m.partner ?? "(unknown)";
      const isGroup = (m.jid ?? "").endsWith("@g.us");
      if (partner !== cur) {
        emit(`\n### ${partner}${isGroup ? " (group)" : ""}\n`);
        cur = partner;
      }
      const sender = m.fromme === 1 ? "Mitch" : isGroup ? "(member)" : partner;
      let content = m.text;
      if (m.mtype === 3) {
        const uuid = m.media ? basename(m.media, extname(m.media)) : "";
        const cf = uuid ? join(cacheDir, `${uuid}.txt`) : "";
        content = cf && existsSync(cf) ? `🎙 ${readFileSync(cf, "utf8").trim()}` : "[voice note]";
      } else if (m.mtype !== 0) {
        content = typeMap[m.mtype] ?? `[type ${m.mtype}]`;
        if (m.text) content += ` ${m.text}`;
      }
      emit(`- \`${m.ts}\` **${sender}:** ${content}`);
    }
    const partners = new Set(msgs.map((m) => m.partner ?? "(unknown)")).size;
    if (msgs.length === 0) emit("_(no messages since last review)_\n");
    return {
      status: "ok",
      note: `${partners} partners, ${msgs.length} msgs, ${transcribed}/${voiceTotal} voice notes transcribed`,
    };
  });

  // ── write digest + print status ────────────────────────────────────────────
  const outDir = "/tmp/espejo-evening-gather";
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${TODAY}.md`);
  writeFileSync(outPath, parts.join("\n"));

  const icon = (s: Status): string => (s === "ok" ? "✓" : s === "warn" ? "⚠" : "❌");
  console.log(`\nEvening gather — ${TODAY} (window from ${SEVEN_AGO})\n`);
  for (const l of logs) console.log(`  ${icon(l.status)} ${l.id}: ${l.note}`);
  const errs = logs.filter((l) => l.status === "error").length;
  const warns = logs.filter((l) => l.status === "warn").length;
  console.log(`\n${errs} error(s), ${warns} warning(s).`);
  console.log(`Digest → ${outPath}`);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  pool.end().finally(() => process.exit(1));
});
