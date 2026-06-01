/**
 * Weekly / Monthly review data gatherer.
 *
 * The windowed sibling of scripts/gather-evening.ts: collects a week's or a
 * month's signal from Postgres (prod) + the local Obsidian vault into one digest
 *   /tmp/espejo-review-gather/<window>-<label>.md
 * Stdout prints per-section status (counts + warnings) and the digest path.
 *
 * Deterministic plumbing half of Artifacts/Prompt/Review/{Weekly,Monthly}.md.
 * Neither review touches WhatsApp/Whisper, so this script has no audio leg.
 *
 * Usage:
 *   pnpm gather:weekly                         # last 7 days ending today (Madrid)
 *   pnpm gather:weekly --end 2026-05-31         # 7-day window ending 2026-05-31 (→ start 05-25)
 *   pnpm gather:weekly --start 2026-05-25 --end 2026-05-31
 *   pnpm gather:monthly                         # current Madrid calendar month
 *   pnpm gather:monthly --month 2026-05         # an explicit month (fixes the now()-bound trap:
 *                                               #  running a monthly a day late into the next
 *                                               #  calendar month would otherwise review the wrong month)
 *
 * DIGEST CONTRACT (the prompts depend on this):
 *   - FULL-TEXT (verbatim, never compressed): weekly → prior Forward block, entries,
 *     Telegram self-capture; monthly → the month's Weekly reviews (anchors), entries.
 *   - SHAPE (tables, read deviation/trend, never recite): tolls, project activity,
 *     agent chats, timeline, Mac activity, screen time.
 *   - Every section is error-wrapped: a broken query surfaces as `❌ ERROR` in both
 *     the digest and stdout, and the run continues. Never fail silently.
 */
import "../src/config.js"; // side-effect: loads .env.production.local when NODE_ENV=production
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { pool } from "../src/db/client.js";
import { parseObsidianNote } from "../src/obsidian/parser.js";

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function opt(name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
}
const WINDOW = opt("--window");
if (WINDOW !== "weekly" && WINDOW !== "monthly") {
  console.error('gather-review: pass --window weekly|monthly (use pnpm gather:weekly / pnpm gather:monthly).');
  process.exit(2);
}

// ── dates (Europe/Madrid) ─────────────────────────────────────────────────────
function madridDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}
function shiftDays(date: string, delta: number): string {
  return madridDate(new Date(new Date(`${date}T12:00:00Z`).getTime() + delta * 86400_000));
}

// Resolve [START, END] inclusive plus, for monthly, the exclusive next-month bound.
let START: string;
let END: string;
let NEXT: string; // exclusive upper bound (END + 1 day for weekly; first-of-next-month for monthly)
let LABEL: string;
if (WINDOW === "weekly") {
  END = opt("--end") ?? madridDate(new Date());
  START = opt("--start") ?? shiftDays(END, -6); // 7-day inclusive window
  NEXT = shiftDays(END, 1);
  LABEL = END;
} else {
  const month = opt("--month") ?? madridDate(new Date()).slice(0, 7); // YYYY-MM
  const [y, m] = month.split("-").map(Number);
  if (!y || !m || m < 1 || m > 12) {
    console.error(`gather-review: --month must be YYYY-MM, got "${month}".`);
    process.exit(2);
  }
  START = `${month}-01`;
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  NEXT = `${ny}-${String(nm).padStart(2, "0")}-01`;
  END = shiftDays(NEXT, -1);
  LABEL = month;
}

// Prior-period baseline bounds — what the window's body arc is read against.
// Weekly: the 7 days immediately before the window. Monthly: the prior calendar month.
const PRIOR_END = shiftDays(START, -1);
const PRIOR_START = WINDOW === "weekly" ? shiftDays(START, -7) : `${PRIOR_END.slice(0, 7)}-01`;

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
  // Every Date-valued column here is a day bucket (pg `date`, parsed by node-pg as
  // local midnight). Render the Madrid calendar date, not an ISO timestamp that
  // reads as the prior day in UTC.
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
function inWindow(d: string | undefined): boolean {
  return !!d && d >= START && d <= END;
}

function gitLog(): string {
  try {
    return execFileSync(
      "git",
      ["log", `--since=${START} 00:00`, `--until=${NEXT} 00:00`, "--pretty=format:%h %ad %s", "--date=short"],
      { cwd: process.cwd(), encoding: "utf8" }
    ).trim();
  } catch (e) {
    return `(git log failed: ${e instanceof Error ? e.message : String(e)})`;
  }
}

/** Files in any of the given vault dirs created or updated within the window. */
function vaultTouched(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    for (const f of listMd(`Artifacts/${dir}`)) {
      const p = parseObsidianNote(readFileSync(f, "utf8"), basename(f));
      const c = p.createdAt ? madridDate(p.createdAt) : undefined;
      const u = p.updatedAt ? madridDate(p.updatedAt) : undefined;
      if (inWindow(c) || inWindow(u)) out.push(`${dir}/${basename(f)}`);
    }
  }
  return out;
}

/**
 * Oura body arc — nightly long-sleep trajectory + a window-vs-prior-baseline
 * deviation row. Shared by weekly and monthly (the prompts' "what the body said"
 * / "body arc" output sections read this). `day` is the wake date; long_sleep
 * only, so naps don't dilute the arc. node-pg returns the integer/float columns
 * as numbers — cast in SQL so ROUND resolves (double precision has no 2-arg ROUND).
 */
async function ouraBody(id: string): Promise<void> {
  await section(id, "SHAPE", async () => {
    const nights = await q(
      `SELECT s.day,
              ROUND((s.total_sleep_duration_seconds/3600.0)::numeric,1) AS sleep_h,
              ROUND((s.rem_sleep_seconds/3600.0)::numeric,1) AS rem_h,
              ROUND((s.deep_sleep_seconds/3600.0)::numeric,1) AS deep_h,
              s.average_hrv AS hrv, s.lowest_heart_rate AS low_hr,
              ROUND(s.efficiency::numeric,0) AS eff,
              ds.score AS sleep_score, r.score AS readiness,
              r.temperature_deviation AS temp_dev
       FROM oura_sleep_sessions s
       LEFT JOIN oura_daily_sleep ds ON ds.day = s.day
       LEFT JOIN oura_daily_readiness r ON r.day = s.day
       WHERE s.sleep_type = 'long_sleep' AND s.day >= $1::date AND s.day <= $2::date
       ORDER BY s.day`,
      [START, END]
    );
    const summary = async (a: string, b: string): Promise<Record<string, unknown>> => {
      const rows = await q(
        `SELECT ROUND((AVG(total_sleep_duration_seconds)/3600.0)::numeric,1) AS avg_sleep_h,
                ROUND(AVG(average_hrv)::numeric,0) AS avg_hrv,
                ROUND(AVG(lowest_heart_rate)::numeric,0) AS avg_low_hr,
                COUNT(*) AS nights
         FROM oura_sleep_sessions
         WHERE sleep_type = 'long_sleep' AND day >= $1::date AND day <= $2::date`,
        [a, b]
      );
      return rows[0] ?? {};
    };
    const prior = await summary(PRIOR_START, PRIOR_END);
    const win = await summary(START, END);
    emit(`**Nightly (day = wake date; long_sleep only):**\n\n${mdTable(nights)}`);
    emit(
      `\n**Window vs prior baseline** (prior = ${PRIOR_START} → ${PRIOR_END}):\n\n` +
        mdTable([
          { period: "window", ...win },
          { period: "prior", ...prior },
        ])
    );
    emit(
      `\n_Read the arc, not the rows: HRV/sleep recovery-or-crash trajectory, deviation from the prior ` +
        `baseline, and the specific nights that broke the trend. Day = the morning he woke._\n`
    );
    return {
      status: nights.length ? "ok" : "warn",
      note: nights.length ? `${nights.length} nights` : "0 Oura nights (sync:oura failed or ring not synced)",
    };
  });
}

// ──────────────────────────────────────────────────────────────────────────────
async function weekly(): Promise<void> {
  // #1 Prior Weekly's Forward block — FULL-TEXT (the loop this week closes)
  await section("#1 Prior Weekly — Forward block", "FULL-TEXT", async () => {
    const priors = listMd("Artifacts/Review")
      .filter((f) => /Weekly Review\.md$/.test(f))
      .map((f) => ({ f, date: basename(f).slice(0, 10) }))
      .filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.date < START)
      .sort((a, b) => a.date.localeCompare(b.date));
    if (priors.length === 0) {
      emit("_(no prior Weekly Review before this window — first run, skip the loop-close)_\n");
      return { status: "warn", note: "no prior weekly" };
    }
    const prior = priors[priors.length - 1];
    const body = parseObsidianNote(readFileSync(prior.f, "utf8"), basename(prior.f)).body;
    // Match the heading "Forward — the week ahead" at line start — NOT the word
    // "forward" mid-paragraph (e.g. "forward-integration shape").
    let idx = body.search(/^\**Forward\b[^\n]*ahead/im);
    if (idx < 0) idx = body.search(/^\s*\**Forward —/m);
    emit(`From **${basename(prior.f, ".md")}**:\n\n${idx >= 0 ? body.slice(idx) : "_(no Forward block found in prior weekly — read it directly)_"}\n`);
    return { status: "ok", note: `from ${prior.date}` };
  });

  // #2 Entries — FULL-TEXT
  await section("#2 Entries (window)", "FULL-TEXT", async () => {
    const rows = await q(
      `SELECT (created_at AT TIME ZONE 'Europe/Madrid')::date AS day, city, text
       FROM entries
       WHERE (created_at AT TIME ZONE 'Europe/Madrid')::date >= $1
         AND (created_at AT TIME ZONE 'Europe/Madrid')::date <= $2
       ORDER BY created_at DESC`,
      [START, END]
    );
    for (const r of rows) emit(`### ${fmtCell(r.day)}${r.city ? ` — ${fmtCell(r.city)}` : ""}\n\n${r.text ?? ""}\n`);
    if (rows.length === 0) emit("_(no entries — did Mitch run `pnpm sync`?)_\n");
    return { status: rows.length ? "ok" : "warn", note: `${rows.length} entries` };
  });

  // #3 Tolls — SHAPE
  await section("#3 Tolls (window)", "SHAPE", async () => {
    const rows = await q(
      `SELECT local_date, to_char(occurred_at AT TIME ZONE 'Europe/Madrid', 'HH24:MI') AS hhmm,
              kind, trigger, body_signal, part_voice, resolution
       FROM checkpoints WHERE local_date >= $1 AND local_date <= $2 ORDER BY occurred_at`,
      [START, END]
    );
    emit(mdTable(rows));
    emit(
      `\n_2026-05-13 convention: substance rows are uses (passes are mental, never logged). ` +
        `Read substance-mix shift, time-of-day signature, body-location drift, which parts spoke — ` +
        `never a pass/go ratio, never a discipline metric without checking logging cadence._\n`
    );
    return { status: "ok", note: `${rows.length} tolls` };
  });

  // #4 Espejo project activity — SHAPE
  await section("#4 Espejo project activity (window)", "SHAPE", async () => {
    const commits = gitLog();
    emit(`**Commits:**\n\n${commits ? "```\n" + commits + "\n```" : "_(none)_"}\n`);
    const touched = vaultTouched(["Insight", "Review", "Note", "Project"]);
    emit(`\n**Vault files created/updated this window (${touched.length}):**\n\n${touched.length ? touched.map((t) => `- ${t}`).join("\n") : "_(none)_"}\n`);
    return { status: "ok", note: `${commits && !commits.startsWith("(git") ? commits.split("\n").length : 0} commits, ${touched.length} files` };
  });

  // #5 Agent chats — SHAPE
  await section("#5 Agent chats (window)", "SHAPE", async () => {
    const rows = await q(
      `SELECT (started_at AT TIME ZONE 'Europe/Madrid')::date AS day,
              to_char(started_at AT TIME ZONE 'Europe/Madrid','HH24:MI') AS t,
              surface, category, SUBSTRING(p->>'text' FROM 1 FOR 200) AS prompt
       FROM agent_sessions, jsonb_array_elements(prompts) p
       WHERE (started_at AT TIME ZONE 'Europe/Madrid')::date >= $1
         AND (started_at AT TIME ZONE 'Europe/Madrid')::date <= $2
         AND p->>'text' NOT LIKE '<local-command-caveat>%'
         AND p->>'text' NOT LIKE '<command-name>%'
       ORDER BY started_at, (p->>'index')::int`,
      [START, END]
    );
    emit(mdTable(rows));
    return { status: "ok", note: `${rows.length} prompts` };
  });

  // #6 Telegram self-capture — FULL-TEXT
  await section("#6 Telegram self-capture (window)", "FULL-TEXT — PRIMARY", async () => {
    const rows = await q(
      `SELECT (created_at AT TIME ZONE 'Europe/Madrid')::date AS day,
              to_char(created_at AT TIME ZONE 'Europe/Madrid','HH24:MI') AS t, content
       FROM chat_messages
       WHERE (created_at AT TIME ZONE 'Europe/Madrid')::date >= $1
         AND (created_at AT TIME ZONE 'Europe/Madrid')::date <= $2
         AND role = 'user' AND (flow = 'chat' OR flow IS NULL)
       ORDER BY created_at`,
      [START, END]
    );
    emit(`_Primary felt-state content; a week is low enough volume to read verbatim. If a daily Evening review already surfaced a thread, confirm it landed rather than re-litigating._\n`);
    let day = "";
    for (const r of rows) {
      if (fmtCell(r.day) !== day) {
        emit(`\n**${fmtCell(r.day)}**`);
        day = fmtCell(r.day);
      }
      emit(`- \`${fmtCell(r.t)}\` ${r.content ?? ""}`);
    }
    if (rows.length === 0) emit("_(no self-capture this window)_\n");
    return { status: "ok", note: `${rows.length} messages` };
  });

  // #7 Telegram interaction timeline — SHAPE
  await section("#7 Telegram timeline (window)", "SHAPE", async () => {
    const rows = await q(
      `SELECT (created_at AT TIME ZONE 'Europe/Madrid')::date AS day,
              to_char(created_at AT TIME ZONE 'Europe/Madrid','HH24:MI') AS t,
              COALESCE(flow, '-') AS flow, SUBSTRING(content FROM 1 FOR 200) AS prompt
       FROM chat_messages
       WHERE (created_at AT TIME ZONE 'Europe/Madrid')::date >= $1
         AND (created_at AT TIME ZONE 'Europe/Madrid')::date <= $2 AND role = 'user'
       ORDER BY created_at`,
      [START, END]
    );
    emit(mdTable(rows));
    emit(`_Read cadence/cluster shape (practice/srs atrophy, vault-prompt cadence). \`chat\` content is full in #6._\n`);
    return { status: "ok", note: `${rows.length} turns` };
  });

  // #8 Mac activity — SHAPE
  await section("#8 Mac activity (window)", "SHAPE", async () => {
    const apps = await q(
      `SELECT app, ROUND(SUM(duration_ms)/60000.0,1) AS min, ROUND(SUM(duration_ms)/60000.0/7.0,1) AS avg_min_per_day
       FROM device_events
       WHERE bucket='window' AND app IS NOT NULL
         AND (started_at AT TIME ZONE 'Europe/Madrid')::date >= $1 AND (started_at AT TIME ZONE 'Europe/Madrid')::date <= $2
       GROUP BY app ORDER BY 2 DESC LIMIT 15`,
      [START, END]
    );
    const hosts = await q(
      `SELECT hostname, ROUND(SUM(duration_ms)/60000.0,1) AS min FROM device_events
       WHERE bucket='web' AND hostname IS NOT NULL
         AND (started_at AT TIME ZONE 'Europe/Madrid')::date >= $1 AND (started_at AT TIME ZONE 'Europe/Madrid')::date <= $2
       GROUP BY hostname ORDER BY 2 DESC LIMIT 15`,
      [START, END]
    );
    const daily = await q(
      `SELECT (started_at AT TIME ZONE 'Europe/Madrid')::date AS day, ROUND(SUM(duration_ms)/60000.0,0) AS min
       FROM device_events
       WHERE bucket='window'
         AND (started_at AT TIME ZONE 'Europe/Madrid')::date >= $1 AND (started_at AT TIME ZONE 'Europe/Madrid')::date <= $2
       GROUP BY 1 ORDER BY 1`,
      [START, END]
    );
    emit(`**Top apps (min, avg/day):**\n\n${mdTable(apps)}`);
    emit(`\n**Top hostnames (min):**\n\n${mdTable(hosts)}`);
    emit(`\n**Daily active-window total:**\n\n${mdTable(daily)}`);
    return { status: apps.length ? "ok" : "warn", note: apps.length ? `${apps.length} apps` : "0 AW rows (ingest failed or AW-quiet — say which)" };
  });

  // #9 iPhone screen time — SHAPE
  await section("#9 iPhone screen time (window)", "SHAPE", async () => {
    const rows = await q(
      `SELECT date, total_minutes, pickups, first_pickup,
              jsonb_path_query_array(apps, '$[*] ? (@.minutes >= 10)') AS apps_10min,
              jsonb_path_query_array(categories, '$[*]') AS cats
       FROM daily_screen_time WHERE date >= $1 AND date <= $2 ORDER BY date DESC`,
      [START, END]
    );
    emit(mdTable(rows));
    emit(`_Read the arc (pickup trend, first-pickup drift, social-app share). Flag missing days so Mitch can upload retroactively._\n`);
    return { status: rows.length ? "ok" : "warn", note: `${rows.length} days logged` };
  });

  // #10 Oura body arc — SHAPE (sleep/HRV recovery-or-crash trajectory)
  await ouraBody("#10 Oura body arc (window)");
}

// ──────────────────────────────────────────────────────────────────────────────
async function monthly(): Promise<void> {
  // #1 The month's Weekly reviews — FULL-TEXT anchors
  await section("#1 Weekly reviews this month (anchors)", "FULL-TEXT", async () => {
    const weeklies = listMd("Artifacts/Review")
      .filter((f) => /Weekly Review\.md$/.test(f))
      .map((f) => ({ f, date: basename(f).slice(0, 10) }))
      .filter((x) => x.date >= START && x.date <= END)
      .sort((a, b) => a.date.localeCompare(b.date));
    for (const w of weeklies) {
      emit(`### ${basename(w.f, ".md")}\n\n${parseObsidianNote(readFileSync(w.f, "utf8"), basename(w.f)).body}\n`);
    }
    if (weeklies.length === 0) emit("_(no Weekly reviews dated within the month — anchor on daily entries below)_\n");
    return { status: weeklies.length ? "ok" : "warn", note: `${weeklies.length} weeklies` };
  });

  // #2 All entries this month — FULL-TEXT texture
  await section("#2 Entries this month", "FULL-TEXT", async () => {
    const rows = await q(
      `SELECT (created_at AT TIME ZONE 'Europe/Madrid')::date AS day, city, text
       FROM entries
       WHERE (created_at AT TIME ZONE 'Europe/Madrid') >= $1::date
         AND (created_at AT TIME ZONE 'Europe/Madrid') <  $2::date
       ORDER BY created_at`,
      [START, NEXT]
    );
    for (const r of rows) emit(`### ${fmtCell(r.day)}${r.city ? ` — ${fmtCell(r.city)}` : ""}\n\n${r.text ?? ""}\n`);
    if (rows.length === 0) emit("_(no entries this month — did Mitch run `pnpm sync`?)_\n");
    return { status: rows.length ? "ok" : "warn", note: `${rows.length} entries` };
  });

  // #3 Tolls this month — SHAPE
  await section("#3 Tolls this month", "SHAPE", async () => {
    const rows = await q(
      `SELECT local_date, to_char(occurred_at AT TIME ZONE 'Europe/Madrid', 'HH24:MI') AS hhmm,
              kind, trigger, body_signal, part_voice, resolution
       FROM checkpoints WHERE local_date >= $1::date AND local_date < $2::date ORDER BY occurred_at`,
      [START, NEXT]
    );
    emit(mdTable(rows));
    emit(`\n_Aggregate the trajectory across the month (week-by-week trend, dominant substance, dominant part). 2026-05-13 convention: rows are uses; never compute pass/go ratios or read volume as discipline without checking logging cadence._\n`);
    return { status: "ok", note: `${rows.length} tolls` };
  });

  // #4 Espejo project activity this month — SHAPE
  await section("#4 Espejo project activity this month", "SHAPE", async () => {
    const commits = gitLog();
    emit(`**Commits:**\n\n${commits ? "```\n" + commits + "\n```" : "_(none)_"}\n`);
    const touched = vaultTouched(["Insight", "Review", "Note", "Project"]);
    emit(`\n**Vault files created/updated this month (${touched.length}):**\n\n${touched.length ? touched.map((t) => `- ${t}`).join("\n") : "_(none)_"}\n`);
    return { status: "ok", note: `${commits && !commits.startsWith("(git") ? commits.split("\n").length : 0} commits, ${touched.length} files` };
  });

  // #5 Agent chats — two cuts (weekly volume, session openers)
  await section("#5 Agent chats this month", "SHAPE", async () => {
    const vol = await q(
      `SELECT date_trunc('week', started_at AT TIME ZONE 'Europe/Madrid')::date AS week_start,
              surface, COUNT(*) AS sessions, SUM(user_msg_count) AS msgs, SUM(tool_call_count) AS tools
       FROM agent_sessions
       WHERE (started_at AT TIME ZONE 'Europe/Madrid') >= $1::date AND (started_at AT TIME ZONE 'Europe/Madrid') < $2::date
       GROUP BY week_start, surface ORDER BY week_start, surface`,
      [START, NEXT]
    );
    const openers = await q(
      `SELECT date_trunc('week', started_at AT TIME ZONE 'Europe/Madrid')::date AS week_start,
              (started_at AT TIME ZONE 'Europe/Madrid')::date AS day, surface, category,
              (SELECT SUBSTRING(p->>'text' FROM 1 FOR 200) FROM jsonb_array_elements(prompts) p
               WHERE p->>'text' NOT LIKE '<local-command-caveat>%' AND p->>'text' NOT LIKE '<command-name>%' LIMIT 1) AS opener
       FROM agent_sessions
       WHERE (started_at AT TIME ZONE 'Europe/Madrid') >= $1::date AND (started_at AT TIME ZONE 'Europe/Madrid') < $2::date
       ORDER BY started_at`,
      [START, NEXT]
    );
    emit(`**Weekly volume:**\n\n${mdTable(vol)}`);
    emit(`\n**Session openers:**\n\n${mdTable(openers)}`);
    return { status: "ok", note: `${vol.length} week×surface rows, ${openers.length} sessions` };
  });

  // #6 Telegram — two cuts (weekly volume by flow, daily self-capture openers)
  await section("#6 Telegram this month", "SHAPE", async () => {
    const vol = await q(
      `SELECT date_trunc('week', created_at AT TIME ZONE 'Europe/Madrid')::date AS week_start,
              COALESCE(flow, '-') AS flow, COUNT(*) AS msgs
       FROM chat_messages
       WHERE (created_at AT TIME ZONE 'Europe/Madrid') >= $1::date AND (created_at AT TIME ZONE 'Europe/Madrid') < $2::date AND role = 'user'
       GROUP BY week_start, flow ORDER BY week_start, flow`,
      [START, NEXT]
    );
    const openers = await q(
      `SELECT DISTINCT ON ((created_at AT TIME ZONE 'Europe/Madrid')::date)
              (created_at AT TIME ZONE 'Europe/Madrid')::date AS day,
              to_char(created_at AT TIME ZONE 'Europe/Madrid','HH24:MI') AS t,
              SUBSTRING(content FROM 1 FOR 300) AS opener
       FROM chat_messages
       WHERE (created_at AT TIME ZONE 'Europe/Madrid') >= $1::date AND (created_at AT TIME ZONE 'Europe/Madrid') < $2::date
         AND role = 'user' AND (flow = 'chat' OR flow IS NULL)
       ORDER BY (created_at AT TIME ZONE 'Europe/Madrid')::date, created_at`,
      [START, NEXT]
    );
    emit(`**Weekly volume by flow:**\n\n${mdTable(vol)}`);
    emit(
      `\n**Daily self-capture openers** (sampler — a day's full freeform was already read by that day's Evening + the covering Weekly; re-open a pivotal day in full only if one looks it):\n\n${mdTable(openers)}`
    );
    return { status: "ok", note: `${vol.length} week×flow rows, ${openers.length} days` };
  });

  // #7 Mac activity — three cuts
  await section("#7 Mac activity this month", "SHAPE", async () => {
    const apps = await q(
      `SELECT app, ROUND(SUM(duration_ms)/60000.0,1) AS total_min, ROUND(SUM(duration_ms)/60000.0/30.0,1) AS avg_min_per_day,
              COUNT(DISTINCT (started_at AT TIME ZONE 'Europe/Madrid')::date) AS active_days
       FROM device_events
       WHERE bucket='window' AND app IS NOT NULL
         AND (started_at AT TIME ZONE 'Europe/Madrid') >= $1::date AND (started_at AT TIME ZONE 'Europe/Madrid') < $2::date
       GROUP BY app ORDER BY 2 DESC LIMIT 20`,
      [START, NEXT]
    );
    const hosts = await q(
      `SELECT hostname, ROUND(SUM(duration_ms)/60000.0,1) AS min FROM device_events
       WHERE bucket='web' AND hostname IS NOT NULL
         AND (started_at AT TIME ZONE 'Europe/Madrid') >= $1::date AND (started_at AT TIME ZONE 'Europe/Madrid') < $2::date
       GROUP BY hostname ORDER BY 2 DESC LIMIT 15`,
      [START, NEXT]
    );
    const weekly = await q(
      `SELECT date_trunc('week', started_at AT TIME ZONE 'Europe/Madrid')::date AS week_start,
              ROUND(SUM(duration_ms)/60000.0,0) AS week_min, ROUND(SUM(duration_ms)/60000.0/7.0,0) AS avg_min_per_day
       FROM device_events
       WHERE bucket='window'
         AND (started_at AT TIME ZONE 'Europe/Madrid') >= $1::date AND (started_at AT TIME ZONE 'Europe/Madrid') < $2::date
       GROUP BY week_start ORDER BY week_start`,
      [START, NEXT]
    );
    emit(`**Top apps (total, avg/day, active days):**\n\n${mdTable(apps)}`);
    emit(`\n**Top hostnames (min):**\n\n${mdTable(hosts)}`);
    emit(`\n**Weekly active-window shape:**\n\n${mdTable(weekly)}`);
    return { status: apps.length ? "ok" : "warn", note: apps.length ? `${apps.length} apps` : "0 AW rows" };
  });

  // #8 iPhone screen time — per-day + weekly aggregates
  await section("#8 iPhone screen time this month", "SHAPE", async () => {
    const daily = await q(
      `SELECT date, total_minutes, pickups, first_pickup,
              jsonb_path_query_array(apps, '$[*] ? (@.minutes >= 10)') AS apps_10min
       FROM daily_screen_time WHERE date >= $1::date AND date < $2::date ORDER BY date`,
      [START, NEXT]
    );
    const weekly = await q(
      `SELECT date_trunc('week', date::timestamp)::date AS week_start, COUNT(*) AS days_logged,
              ROUND(AVG(total_minutes),0) AS avg_min, ROUND(AVG(pickups),0) AS avg_pickups, MIN(first_pickup) AS earliest_first_pickup
       FROM daily_screen_time WHERE date >= $1::date AND date < $2::date GROUP BY week_start ORDER BY week_start`,
      [START, NEXT]
    );
    emit(`**Per-day:**\n\n${mdTable(daily)}`);
    emit(`\n**Weekly aggregates** (upload cadence is itself signal — a zero-row week means he stopped logging or was off the phone):\n\n${mdTable(weekly)}`);
    return { status: daily.length ? "ok" : "warn", note: `${daily.length} days logged` };
  });

  // #9 Oura body arc — SHAPE (month-long sleep/HRV trajectory vs prior month)
  await ouraBody("#9 Oura body arc (this month)");
}

// ──────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const title = WINDOW === "weekly" ? `Weekly gather — ${START} → ${END}` : `Monthly gather — ${LABEL} (${START} → ${END})`;
  emit(`# ${title}`);
  emit(`_Generated by scripts/gather-review.ts._`);
  emit(
    `\n> **How to read this digest.** FULL-TEXT sections are primary source — quote and weave, ` +
      `never compress. SHAPE sections are tables — read trend/deviation across the window, never ` +
      `recite raw numbers. Any \`❌ ERROR\` is a real failure: surface it, don't gather past it.\n`
  );

  if (WINDOW === "weekly") await weekly();
  else await monthly();

  const outDir = "/tmp/espejo-review-gather";
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${WINDOW}-${LABEL}.md`);
  writeFileSync(outPath, parts.join("\n"));

  const icon = (s: Status): string => (s === "ok" ? "✓" : s === "warn" ? "⚠" : "❌");
  console.log(`\n${title}\n`);
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
