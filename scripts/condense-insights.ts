/**
 * Condense Artifacts/Insight/*.md files per the rubric in
 * ~/Documents/Artifacts/Prompt/Insights Condense.md.
 *
 * Usage:
 *   pnpm tsx scripts/condense-insights.ts            # dry-run to /tmp/condense-preview/
 *   pnpm tsx scripts/condense-insights.ts --apply    # overwrite originals
 *   pnpm tsx scripts/condense-insights.ts --limit 20 # only first 20 files
 *   pnpm tsx scripts/condense-insights.ts --file "nicotine"  # filter
 */

import { readFile, writeFile, readdir, mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import OpenAI from 'openai';
import 'dotenv/config';

const INSIGHT_DIR = 'Artifacts/Insight';
const PREVIEW_DIR = '/tmp/condense-preview';
const MODEL = 'gpt-4o';
const CONCURRENCY = 10;

const apply = process.argv.includes('--apply');
const limitArg = process.argv.indexOf('--limit');
const limit = limitArg >= 0 ? parseInt(process.argv[limitArg + 1], 10) : Infinity;
const fileArg = process.argv.indexOf('--file');
const fileFilter = fileArg >= 0 ? process.argv[fileArg + 1].toLowerCase() : null;

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYSTEM_PROMPT = `You are condensing personal journal "insight" notes to tight atomic zettels. These are deeply personal notes about therapy, parts work, substances, and attachment. Preserve the author's voice, exact phrasings, and specific evidence. Do not moralize, hedge, soften, or paraphrase when the original wording is fine.

INPUT FORMAT
Each file has: YAML frontmatter, a body (markdown paragraphs), and a "## Sources" section with wikilinks. There may also be a "## Related" section.

YOUR TASK
Return the file with the body condensed per the rubric below. Output must be valid markdown in the EXACT same structural format: frontmatter + body + Sources. NEVER include a "## Related" section. NEVER wrap in code fences. NEVER add commentary.

OPERATING PRINCIPLE — LEAST-EDIT
Your default is to change nothing. Only edit when a specific item on the STRIP list is present. If you are tempted to paraphrase a sentence because "it could be shorter," STOP — that is over-reach. Short notes with no Related/h1/status/meta-commentary should come back UNCHANGED.

STRIP (actively remove)
- "## Related" section entirely — wikilink soup; embeddings serve the same purpose
- Duplicate "# Title" heading at top of body when it matches filename/frontmatter
- Meta-commentary: "This suggests…", "Worth monitoring…", "This marks a significant step…", "could reveal…", "seems linked to…", "is now clearly seen as…", "worth tracking", "This is a signal to…", "Worth remembering…"
- Closing restatements that repeat the opening claim in different words
- Tag bloat: reduce to 3–5 semantic anchors, drop near-synonyms (adhd/ADHD, pattern/patterns). Normalize casing (adhd → ADHD, cptsd → C-PTSD).
- Narrative setup that only supplies a date already in Sources ("On 2026-03-15, Mitch noticed..." → "Mitch noticed...")
- "status: approved" and similar workflow-state fields

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

DO NOT ADD
- Do NOT add new tags to notes that have none. Only prune existing tag lists.
- Do NOT add commentary, framing, or transitions.
- Do NOT rewrite opening sentences "for clarity" — keep the author's phrasing.

LEAVE ALONE
If a file has no "## Related", no duplicate "# h1", no "status: approved", no more than 5 tags, and no textbook meta-commentary phrases — return it BYTE-FOR-BYTE unchanged.

FRONTMATTER
Keep: kind, created_at, updated_at, tags (if present, pruned to 3-5)
Drop: status, excessive tags, near-duplicate tags

OUTPUT FORMAT (strict)
---
kind: insight
created_at: YYYY-MM-DD
updated_at: YYYY-MM-DD
tags:
  - tag1
  - tag2
---
<body paragraphs — preserve structure and voice>

## Sources
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

  if (!apply) {
    if (existsSync(PREVIEW_DIR)) await rm(PREVIEW_DIR, { recursive: true, force: true });
    await mkdir(PREVIEW_DIR, { recursive: true });
  }

  const results = await pool(files, CONCURRENCY, condense);

  let changed = 0;
  let unchanged = 0;
  let errors = 0;
  let totalOriginalLen = 0;
  let totalCondensedLen = 0;

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

    const outPath = apply ? join(INSIGHT_DIR, r.file) : join(PREVIEW_DIR, r.file);
    await writeFile(outPath, r.condensed, 'utf-8');
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
  if (!apply) {
    console.log(`Review:  diff -r ${INSIGHT_DIR} ${PREVIEW_DIR}`);
    console.log(`Apply:   pnpm tsx scripts/condense-insights.ts --apply`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
