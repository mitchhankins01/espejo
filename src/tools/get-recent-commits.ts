import type pg from "pg";
import { validateToolInput } from "../../specs/tools.spec.js";
import { config } from "../config.js";

interface GithubCommitResponse {
  sha: string;
  html_url: string;
  commit: {
    author: { date: string; name?: string };
    message: string;
  };
}

function startOfTodayLocalIso(tz: string): string {
  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const today = dateFmt.format(new Date()); // YYYY-MM-DD in tz
  const [y, m, d] = today.split("-").map((n) => parseInt(n, 10));
  // utcMidnight = the UTC instant whose ISO is `${today}T00:00:00Z`.
  const utcMidnight = Date.UTC(y, m - 1, d);
  // What HH:MM does the local clock read at that UTC instant?
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const [hh, mm] = timeFmt.format(new Date(utcMidnight)).split(":").map((n) => parseInt(n, 10));
  const offsetMinutes = hh * 60 + mm;
  // If local date is still today at utcMidnight → east of UTC, local midnight precedes utcMidnight.
  // If local date is yesterday → west of UTC, local midnight is later than utcMidnight.
  const localDateAtUtcMidnight = dateFmt.format(new Date(utcMidnight));
  const localMidnightMs =
    localDateAtUtcMidnight === today
      ? utcMidnight - offsetMinutes * 60_000
      : utcMidnight + (24 * 60 - offsetMinutes) * 60_000;
  return new Date(localMidnightMs).toISOString();
}

function firstLine(message: string): string {
  const idx = message.indexOf("\n");
  return idx === -1 ? message : message.slice(0, idx);
}

export async function handleGetRecentCommits(
  _pool: pg.Pool,
  input: unknown
): Promise<string> {
  const params = validateToolInput("get_recent_commits", input);
  const since = params.since_iso ?? startOfTodayLocalIso(config.timezone);
  const { owner, repo } = config.github;

  const url = `https://api.github.com/repos/${owner}/${repo}/commits?since=${encodeURIComponent(since)}&per_page=${params.limit}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "espejo-mcp",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return `GitHub API error (${res.status}): ${body.slice(0, 200)}`;
  }

  const commits = (await res.json()) as GithubCommitResponse[];
  if (!Array.isArray(commits) || commits.length === 0) {
    return `No commits to ${owner}/${repo} since ${since}.`;
  }

  const lines = commits.map((c) => {
    const shortSha = c.sha.slice(0, 7);
    const subject = firstLine(c.commit.message);
    return `${shortSha} ${c.commit.author.date} ${subject}`;
  });

  return `${commits.length} commit${commits.length === 1 ? "" : "s"} to ${owner}/${repo} since ${since}:\n\n${lines.join("\n")}`;
}
