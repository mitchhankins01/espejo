/**
 * Condense Artifacts/Insight/*.md files per the rubric in
 * ~/Documents/Artifacts/Prompt/Insights/Condense.md.
 *
 * Usage:
 *   pnpm tsx scripts/condense-insights.ts            # dry-run to /tmp/condense-preview/
 *   pnpm tsx scripts/condense-insights.ts --apply    # overwrite originals
 *   pnpm tsx scripts/condense-insights.ts --limit 20 # only first 20 files
 *   pnpm tsx scripts/condense-insights.ts --file "nicotine"  # filter
 *
 * Both modes generate /tmp/condense-preview/preview.md — a dedup-prompt-style
 * markdown report with a summary table at the top and per-file unified diffs.
 */

import { readFile, writeFile, readdir, mkdir, rm } from 'fs/promises';
import { existsSync, writeFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { spawn } from 'child_process';
import OpenAI from 'openai';
import 'dotenv/config';
import { config } from '../src/config.js';

const INSIGHT_DIR = 'Artifacts/Insight';
const PREVIEW_DIR = '/tmp/condense-preview';
const PREVIEW_MD = join(PREVIEW_DIR, 'preview.md');
const MODEL = config.models.openaiCondense;
const CONCURRENCY = 10;

const apply = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
const fileArg = process.argv.indexOf('--file');
const fileFilter = fileArg >= 0 ? process.argv[fileArg + 1].toLowerCase() : null;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are condensing personal journal "insight" notes to tight atomic zettels. These are deeply personal notes about therapy, parts work, substances, and attachment.

The downstream goal is high signal-per-token: another LLM pipeline (dedup council) reads these condensed insights and decides whether near-duplicates should be merged or kept separate. Less noise → cleaner merge decisions. Your job is to remove framing/restatement/meta while preserving every specific the dedup pipeline might key on.

Preserve the author's voice, exact phrasings, and specific evidence. Do not moralize, hedge, soften, or paraphrase when the original wording is fine.

INPUT FORMAT
Each file has: YAML frontmatter, a body (markdown paragraphs), and optionally a "## Sources" section with wikilinks. There may also be a "## Related" section.

YOUR TASK
Return the file with the body condensed per the rubric below. Output must be valid markdown in the EXACT same structural format: frontmatter + body + (Sources if present in original). NEVER include a "## Related" section. NEVER wrap in code fences. NEVER add commentary.

OPERATING PRINCIPLE — LEAST-EDIT
Your default is to change nothing. Only edit when a specific item on the STRIP list is present. If you are tempted to paraphrase a sentence because "it could be shorter," STOP — that is over-reach. Short notes with no Related/h1/status/meta-commentary/title-restate should come back UNCHANGED. When you strip a title-restating opening or closing-meta sentence, do NOT rewrite the remaining sentences "to flow better" — keep them verbatim.

TITLE-RESTATE TEST (apply before stripping any body opening)
Does the next sentence still parse if the opening is removed?
- YES → strip the opening (it was restating the title).
- NO → the opening is load-bearing (often part of a metaphor "X is Y. Like Z..." or a continuation). Keep it.

Example STRIP: title "Empathy defaults outward not inward — felt-sense routed through Oura", body opens "Empathy defaults outward, not inward — when asked how the body was, he answered with the Oura recovery score twice…" → strip "Empathy defaults outward, not inward — "; rest parses standalone.

Example KEEP: title "Verlo dejalo stayed an abstraction today — pre-emergence, not failure", body opens "*Verlo, déjalo* stayed an abstraction today — pre-emergence, not failure. Like parts going from the OS background to a separate thing: …" → KEEP. Stripping breaks "Like parts going from…" (no antecedent).

STRIP — STRUCTURAL
- "## Related" section entirely — wikilink soup; embeddings serve the same purpose
- Duplicate "# Title" heading at top of body when it matches filename/frontmatter
- "status: approved" and similar workflow-state fields
- Tag bloat: reduce to 3–5 semantic anchors, drop near-synonyms (adhd/ADHD, pattern/patterns). Normalize casing (adhd → ADHD, cptsd → C-PTSD).

STRIP — TITLE-RESTATE (biggest single noise source — ~100 files)
- Title-restating opening sentence/clause (apply the TITLE-RESTATE TEST above): when the body's first sentence repeats the filename's claim (same noun phrases, same verb, same shape), drop the restatement and start with the evidence/mechanism.
- "is not X but Y" closer when the title already states the contrast ("A is X, not Y" + body ending "This is not Y but X"). Drop the body restatement.

STRIP — PREAMBLE / SETUP COMPRESSION
- Long opening preambles ("When X happened, Mitch [verb]ed Y…" / "On [date], …"): compress to the core observation. Preserve quoted dialogue, somatic signatures, named concepts, and metrics; drop the context-setting clause when the claim alone is intelligible. Preferred form: "Asked to X, [body]…" instead of "When asked to X, Mitch's body…".
- Narrative date setup that only supplies a date already in Sources ("On 2026-03-15, Mitch noticed..." → "Mitch noticed...").
- 3rd-person attribution verbs when the act of noticing isn't the point: "Mitch noted X" / "Mitch identified Y" / "he recognized/observed/realized/described Z" → just X / Y / Z. PRESERVE when Mitch quotes himself verbatim ("Mitch said 'X'") or when the noticing IS the insight.

STRIP — META-COMMENTARY (broad — covers ~50+ closing-sentence patterns)
- Phrases: "This suggests…", "Worth monitoring…", "This marks a significant step…", "could reveal…", "seems linked to…", "is now clearly seen as…", "worth tracking", "This is a signal to…", "Worth remembering…"
- "This [is/represents/marks/signals/reframes/reveals/gives] X" when X restates the title
- "The [insight|reframe|move|condition|mechanism|distinction|skill|practice|frame|goal|next step|recommendation|diagnostic question] is X" when X restates the title
- "This [pattern|distinction|phenomenon|reframe|observation] matters/reveals/marks/signals/reflects/gives" when it restates the title
- "is itself a/the X", "is the [signature|platform|metric|practice|skill|signal] of/that"
- "represents the…", "marks the…", "reframes [X] as [Y]"
- "Recognizing this [pattern|signal|gap] is…"
- "is engineering, not pathology"-style epigrams when they restate the title
- Tutorial framing as standalone closers: "The mechanism: [restatement]", "The condition is: [restatement]", "The frame is: [restatement]". Compress to just the mechanism/condition/frame OR drop entirely if it restates earlier content.
- Closing restatements that repeat the opening claim in different words.

STRIP — WORD-LEVEL FLAB (surgical drops)
- Hedge softeners (drop unless the uncertainty is the point): "may be", "might be", "perhaps", "could be", "may suggest", "may indicate", "may reflect", "may signal".
- Filler abstractions (drop them): "fundamentally", "essentially", "in essence", "basically", "in some sense", "to some degree".
- Emphasis adverbs at sentence-open (drop the adverb; keep the sentence): "Notably,", "Crucially,", "Importantly,", "Interestingly,".
- Forward-looking framing that adds no operational detail: "going forward", "moving forward", "the recommendation is to…" when followed by content already implied by the title.

PRESERVE VERBATIM (do NOT paraphrase or drop)
- Concrete sequences and stacks: "builder's high → vape → late food → 6am bedtime", "fawn → pressure → dopamine-seeking → explosion → judgment"
- Parenthetical evidence: "(sleep 52, HRV 45)", "(ketamine, weed, nicotine, two hookups)", "(gym validation, sauna cruising, vape)"
- Named concepts and user-coined phrases: rouwen, escalera, fawn cascade, Ocean Floor, Car Theory, Estoy subiendo, Proyecto Mitch, Tengo suficiente, keeps the lights on, soy malo, nutro lo que quiero ser, veremos, comfy crash, frazzled, amarillo, verde
- Specific metrics when the metric IS evidence: HRV 45, sleep 52, 94k steps, 36 workouts, sleep score 46, couldn't sleep until 6am
- Anchoring dates inside body: "since October 2022", "March 7 observation:", "April 19, 2026", "on Feb 10"
- Proper nouns: Nicolás, Isa, Hans, Jesse, Vincent, Pete, Fabi, Nico, Odei, Daniel, Dayana, Gustavo, Julia, Markus, Rachel, Carlos, Jon, Anthony, Joey, Sebastian, Lorenzo, Leonardo
- Quotes with attribution
- Therapy-session / part / book references: "Session 4", "Session 6", "the Puppy", "the Blocker", "the Judge", "the Fawn Response", "Ayahuasca September 2025", "From Cage to Freedom"
- Multi-paragraph structure when each paragraph carries a distinct atomic observation — keep the paragraph breaks, don't merge paragraphs
- "## Sources" section verbatim — never modify wikilinks, never drop sources

DO NOT ADD / FABRICATE
- Do NOT add a "## Sources" section if the original has none. Never invent a Sources wikilink. If the original ends after the body, the output ends after the body.
- Do NOT add "created_at" or "updated_at" to frontmatter if they are not in the original. Never invent dates from filename, body content, or guesses.
- Do NOT add new tags. Tags can only be PRUNED — never replaced, supplemented, or substituted. Output tag list MUST be a subset of input tag list. If the file has tags [a, b], output is some subset of [a, b] — never [a, c] or [a, b, c].
- Do NOT add commentary, framing, or transitions.
- Do NOT rewrite opening sentences "for clarity" — keep the author's phrasing.

LEAVE ALONE
If a file has no "## Related", no duplicate "# h1", no "status: approved", no more than 5 tags, no textbook meta-commentary phrases, and no title-restate opening — return it BYTE-FOR-BYTE unchanged.

FRONTMATTER
Keep: kind, created_at, updated_at, tags (if present, pruned to 3-5)
Drop: status, excessive tags, near-duplicate tags

OUTPUT FORMAT (strict — every field is CONDITIONAL on being present in the original)
---
kind: insight
created_at: YYYY-MM-DD     # ONLY include if present in original; never fabricate
updated_at: YYYY-MM-DD     # ONLY include if present in original; never fabricate
tags:                      # ONLY include if present in original
  - tag1                   # MUST be a subset of original tags — never add new ones
  - tag2
---
<body paragraphs — preserve structure and voice>

## Sources                 # ONLY include if present in original; never invent
<unchanged wikilinks, one per line>`;

interface Result {
  file: string;
  original: string;
  condensed: string;
  changed: boolean;
  error?: string;
}

async function condense(filename: string): Promise<Result> {
  const path = join(INSIGHT_DIR, filename);
  const original = await readFile(path, 'utf-8');

  try {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: original },
      ],
      temperature: 0.2,
    });

    let condensed = response.choices[0]?.message?.content?.trim() ?? '';

    // Strip code fences if model wrapped output despite instructions
    if (condensed.startsWith('```')) {
      condensed = condensed.replace(/^```(?:markdown)?\n/, '').replace(/\n```$/, '');
    }

    // Ensure trailing newline
    if (!condensed.endsWith('\n')) condensed += '\n';

    return {
      file: filename,
      original,
      condensed,
      changed: condensed.trim() !== original.trim(),
    };
  } catch (err) {
    return {
      file: filename,
      original,
      condensed: original,
      changed: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function pool<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch = items.slice(i, i + size);
    const batchResults = await Promise.all(batch.map(fn));
    results.push(...batchResults);
    process.stdout.write(`  ${Math.min(i + size, items.length)}/${items.length}\r`);
  }
  process.stdout.write('\n');
  return results;
}

// ──── preview / diff helpers ────────────────────────────────────────────────

interface Classification {
  type: 'tag-only' | 'body' | 'both';
  summary: string;
  flags: string[];
}

function splitFile(content: string): { front: string; rest: string } {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { front: '', rest: content };
  return { front: m[1], rest: m[2] };
}

function extractTags(front: string): string[] {
  const block = front.match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
  if (!block) return [];
  return block[1]
    .split('\n')
    .map((l) => l.match(/^\s*-\s*(.+?)\s*$/)?.[1])
    .filter((t): t is string => !!t);
}

function classifyChange(orig: string, condensed: string): Classification {
  const o = splitFile(orig);
  const n = splitFile(condensed);
  const fmChanged = o.front.trim() !== n.front.trim();
  const bodyChanged = o.rest.trim() !== n.rest.trim();

  let type: Classification['type'];
  if (fmChanged && !bodyChanged) type = 'tag-only';
  else if (!fmChanged && bodyChanged) type = 'body';
  else type = 'both';

  // Detect potential fabrications
  const flags: string[] = [];
  const oTags = extractTags(o.front);
  const nTags = extractTags(n.front);
  const added = nTags.filter((t) => !oTags.includes(t));
  if (added.length > 0) flags.push(`+tags: ${added.join(', ')}`);
  if (!orig.includes('## Sources') && condensed.includes('## Sources')) flags.push('+Sources');
  if (!/^created_at:/m.test(o.front) && /^created_at:/m.test(n.front)) flags.push('+created_at');
  if (!/^updated_at:/m.test(o.front) && /^updated_at:/m.test(n.front)) flags.push('+updated_at');

  // Summary
  let summary: string;
  const dropped = oTags.filter((t) => !nTags.includes(t));
  if (type === 'tag-only') {
    summary = dropped.length ? `tags −${dropped.length}: ${dropped.join(', ')}` : 'frontmatter edit';
  } else if (type === 'body') {
    const delta = n.rest.length - o.rest.length;
    summary = `body ${delta >= 0 ? '+' : ''}${delta} chars`;
  } else {
    const delta = n.rest.length - o.rest.length;
    const tagPart = dropped.length ? `tags −${dropped.length}` : 'frontmatter';
    summary = `${tagPart}, body ${delta >= 0 ? '+' : ''}${delta} chars`;
  }

  return { type, summary, flags };
}

async function unifiedDiff(orig: string, condensed: string, label: string): Promise<string> {
  const tmpOrig = `/tmp/.condense-diff-orig-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  const tmpNew = `/tmp/.condense-diff-new-${process.pid}-${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmpOrig, orig);
  writeFileSync(tmpNew, condensed);

  return new Promise<string>((resolve) => {
    const child = spawn('diff', ['-u', '--label', `a/${label}`, '--label', `b/${label}`, tmpOrig, tmpNew]);
    let out = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.on('close', () => {
      try {
        unlinkSync(tmpOrig);
        unlinkSync(tmpNew);
      } catch {
        /* ignore */
      }
      resolve(out);
    });
    child.on('error', () => {
      try {
        unlinkSync(tmpOrig);
        unlinkSync(tmpNew);
      } catch {
        /* ignore */
      }
      resolve('');
    });
  });
}

function escMd(s: string): string {
  return s.replace(/\|/g, '\\|');
}

async function writePreview(
  results: Result[],
  isApply: boolean,
  totalOriginalLen: number,
  totalCondensedLen: number,
  totalFiles: number,
): Promise<void> {
  const changed = results.filter((r) => r.changed && !r.error);
  const errors = results.filter((r) => !!r.error);

  const classified = changed.map((r) => ({
    r,
    c: classifyChange(r.original, r.condensed),
  }));

  const violationRows = classified.filter((x) => x.c.flags.length > 0);
  const bodyRows = classified.filter((x) => x.c.flags.length === 0 && x.c.type !== 'tag-only');
  const tagOnlyRows = classified.filter((x) => x.c.flags.length === 0 && x.c.type === 'tag-only');

  const reduction = totalOriginalLen
    ? ((1 - totalCondensedLen / totalOriginalLen) * 100).toFixed(1)
    : '0';

  let md = `# Condense Insights — Preview\n\n`;
  md += `**Mode:** ${isApply ? 'APPLIED' : 'DRY-RUN'}\n`;
  md += `**Files processed:** ${totalFiles}\n`;
  md += `**Files changed:** ${changed.length}\n`;
  md += `**Files unchanged:** ${totalFiles - changed.length - errors.length}\n`;
  if (errors.length > 0) md += `**Errors:** ${errors.length}\n`;
  md += `**Size:** ${totalOriginalLen.toLocaleString()} → ${totalCondensedLen.toLocaleString()} chars (−${reduction}%)\n\n`;
  if (violationRows.length > 0) {
    md += `⚠️ **${violationRows.length} files have flagged changes** (potential fabrications — review the Violations section below).\n\n`;
  }

  // Summary table (violations first, then body edits, then tag-only)
  md += `## Summary Table\n\n`;
  md += `| # | File | Change | Flag |\n|---|------|--------|------|\n`;
  let idx = 1;
  for (const x of [...violationRows, ...bodyRows, ...tagOnlyRows]) {
    const flagCell = x.c.flags.length ? `⚠️ ${x.c.flags.join(' · ')}` : '';
    md += `| ${idx} | ${escMd(x.r.file)} | ${x.c.summary} | ${flagCell} |\n`;
    idx++;
  }
  md += `\n`;

  // Violations section (full diffs)
  if (violationRows.length > 0) {
    md += `---\n\n## ⚠️ Violations (${violationRows.length})\n\n`;
    md += `These changes look like fabrications: invented Sources sections, invented date fields, or new tags. Review each before applying.\n\n`;
    for (const x of violationRows) {
      md += `### ${x.r.file}\n\n`;
      md += `**Flag:** ${x.c.flags.join(', ')}\n\n`;
      const d = await unifiedDiff(x.r.original, x.r.condensed, x.r.file);
      md += '```diff\n' + d + '```\n\n';
    }
  }

  // Body edits (full diffs)
  if (bodyRows.length > 0) {
    md += `---\n\n## Body Edits (${bodyRows.length})\n\n`;
    for (const x of bodyRows) {
      md += `### ${x.r.file}\n\n`;
      const d = await unifiedDiff(x.r.original, x.r.condensed, x.r.file);
      md += '```diff\n' + d + '```\n\n';
    }
  }

  // Tag-only changes (collapsed)
  if (tagOnlyRows.length > 0) {
    md += `---\n\n## Tag-Only Changes (${tagOnlyRows.length})\n\n`;
    md += `<details>\n<summary>Click to expand — pure tag prunes, no body changes</summary>\n\n`;
    md += `| File | Tags dropped |\n|------|--------------|\n`;
    for (const x of tagOnlyRows) {
      const o = splitFile(x.r.original);
      const n = splitFile(x.r.condensed);
      const dropped = extractTags(o.front).filter((t) => !extractTags(n.front).includes(t));
      md += `| ${escMd(x.r.file)} | ${dropped.join(', ') || '(frontmatter edit)'} |\n`;
    }
    md += `\n</details>\n`;
  }

  // Errors
  if (errors.length > 0) {
    md += `---\n\n## Errors (${errors.length})\n\n`;
    for (const e of errors) {
      md += `- \`${e.file}\` — ${e.error}\n`;
    }
    md += `\n`;
  }

  await writeFile(PREVIEW_MD, md, 'utf-8');
}

// ──── main ──────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('OPENAI_API_KEY not set');
    process.exit(1);
  }

  const all = (await readdir(INSIGHT_DIR)).filter((f) => f.endsWith('.md'));
  let files = all.sort();
  if (fileFilter) {
    files = files.filter((f) => f.toLowerCase().includes(fileFilter));
  }
  files = files.slice(0, limit);

  console.log(
    `Mode: ${apply ? 'APPLY (overwriting originals)' : 'DRY-RUN (writing to ' + PREVIEW_DIR + ')'}`,
  );
  console.log(`Files to process: ${files.length} / ${all.length}`);
  console.log(`Model: ${MODEL}, concurrency: ${CONCURRENCY}`);
  console.log('');

  // Always (re)create PREVIEW_DIR so diffs + preview.md land cleanly
  if (existsSync(PREVIEW_DIR)) await rm(PREVIEW_DIR, { recursive: true, force: true });
  await mkdir(PREVIEW_DIR, { recursive: true });

  const results = await pool(files, CONCURRENCY, condense);

  let changed = 0;
  let unchanged = 0;
  let errors = 0;
  let totalOriginalLen = 0;
  let totalCondensedLen = 0;

  // First pass: write condensed versions to PREVIEW_DIR (always), tally counts.
  // We delay overwriting originals until AFTER preview.md is generated so the
  // diff comparison is against the on-disk original, not a modified copy.
  for (const r of results) {
    if (r.error) {
      errors++;
      console.error(`ERROR ${r.file}: ${r.error}`);
      continue;
    }
    totalOriginalLen += r.original.length;
    totalCondensedLen += r.condensed.length;

    if (!r.changed) {
      unchanged++;
      continue;
    }
    changed++;
    await writeFile(join(PREVIEW_DIR, r.file), r.condensed, 'utf-8');
  }

  // Generate preview.md (originals still intact at INSIGHT_DIR/)
  await writePreview(results, apply, totalOriginalLen, totalCondensedLen, files.length);

  // If --apply, NOW overwrite originals
  if (apply) {
    for (const r of results) {
      if (r.error || !r.changed) continue;
      await writeFile(join(INSIGHT_DIR, r.file), r.condensed, 'utf-8');
    }
  }

  const reduction = totalOriginalLen
    ? ((1 - totalCondensedLen / totalOriginalLen) * 100).toFixed(1)
    : '0';

  console.log('');
  console.log(`Changed:   ${changed}`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Errors:    ${errors}`);
  console.log(`Size:      ${totalOriginalLen} → ${totalCondensedLen} chars (-${reduction}%)`);
  console.log('');
  console.log(`Preview:   code ${PREVIEW_MD}`);
  if (!apply) {
    console.log(`Apply:     pnpm tsx scripts/condense-insights.ts --apply`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
