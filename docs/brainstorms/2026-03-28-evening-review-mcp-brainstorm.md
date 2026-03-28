# Brainstorm: Evening Review MCP Tools

**Date:** 2026-03-28
**Status:** Draft

## What We're Building

An MCP prompt + save tool that replace the manual workflow of pasting a long evening review system prompt into Claude Desktop:

1. **MCP Prompt: `evening-review`** — Registered via `registerPrompt`. When selected in Claude Desktop's prompt picker, the handler queries the DB and returns conversation messages containing: the full evening review system prompt plus all context data (7 days of journal entries, review artifacts from the same window, Oura weekly analysis, weight trend). Claude starts the session immediately — zero manual setup.

2. **MCP Tool: `save_evening_review`** — Takes the final review entry text and saves it as a knowledge artifact. Called by Claude at the end of the session after user feedback on the draft. Artifact defaults: `kind: 'review'`, `status: 'pending'`, `source: 'mcp'`, no tags. Title format: `YYYY-MM-DD — Evening Checkin` (e.g., `2026-03-28 — Evening Checkin`).

## The "Why" Behind the Evening Review

### Core purpose

The evening review serves two functions:

1. **Processing the day** — giving the day a place to land emotionally and somatically, so unprocessed experiences don't stack up and leak into the next day.
2. **Capturing data and patterns** — each review feeds future sessions. Consistent data collection opens up options over time (trend detection, correlation analysis, etc.).

The data is primarily for future evening review sessions — Claude seeing "boundaries yellow for 4 days" only works if past reviews exist. It's not primarily for personal re-reading.

### Why the personality matters

The "Dutch auntie" persona isn't decorative — it's an ADHD engagement strategy. Executive dysfunction and procrastination mean the session needs to be **engaging and novel** enough to hold attention. A neutral therapist voice triggers disengagement or performative responses. The sass and directness create emotional texture that keeps the session alive, especially on tired/resistant nights.

### The three-system model (Escalera / Boundaries / Attachment)

This is the core analytical framework, not an experimental addition:

- **Escalera** — stacking/escalation behavior, especially dopamine-seeking (food is a primary one). Weight guideline ranges map to this.
- **Boundaries** — ambient pressure from work, people, unspoken yeses. A declining boundary trend is the lead indicator that escalera is about to fire.
- **Attachment** — connection fed or starved. Loneliness humming underneath.

Key insight: these system states also appear in morning journal entries (self-reported). So the prompt handler pulling 7 days of entries gives Claude *both* the user's self-assessment AND the data to validate or challenge it.

### Spanish integration (simplified)

Just "conduct in B1 Spanish." User can read Spanish fine and will respond in English if too tired. No complex progressive-immersion rules — that was over-specified.

### Output format (let Claude decide)

The original prompt had 8 rigid sections. In practice, Claude should write a grounded evening entry in the user's voice with the three-system state included, but find its own shape based on what actually emerged in the session. The sections evolved from prompt engineering, not from what actually matters.

Must include: system state (escalera/boundaries/attachment — green/yellow/red) and boundary score. Everything else is Claude's call based on the conversation.

## Why This Architecture

### The problem: three friction points that kill the practice

1. **Setup friction** — Pasting a long system prompt every evening. On tired nights (the nights that matter most), this is enough to skip.
2. **Shallow context** — Claude Desktop can't natively access journal history, Oura, or past reviews. Manual tool calls with no continuity.
3. **No review-to-review continuity** — Each session starts from zero. The three-system scan needs trend data to work.

### Why MCP Prompt + Tool

- **Prompt** (`registerPrompt`) is the right primitive for "start a conversation with instructions and context." One click in the prompt picker — zero tool calls, no prompt pasting.
- **Tool** is the right primitive for the save — a discrete write action at the end.

### Why minimal context (no patterns, no todos)

The evening review is about processing the day somatically and emotionally. Todos pull toward coaching. Long-term patterns dilute focus on this week's trajectory. Entries + reviews + Oura + weight is the right signal-to-noise ratio.

## Key Decisions

1. **Session happens in Claude Desktop/Code via MCP** — not Telegram, not a dedicated web UI. MCP prompt is the trigger.

2. **MCP Prompt for start, MCP Tool for save** — `registerPrompt('evening-review')` handles context assembly and prompt delivery. `save_evening_review` tool handles artifact creation. Clean separation: read vs write, start vs end.

3. **Context window: 7 days, same window for everything** — Entries from last 7 days. Reviews (artifacts, kind: 'review') from the same 7-day window. Oura weekly analysis. Weight trend for 7 days. If no reviews exist in that window, just note "no reviews in last 7 days."

4. **System prompt hardcoded in code** — The evening review personality, three-system model, weight guidelines, and question compass live in the prompt handler's code. Updated via code changes, not via templates or artifacts.

5. **Output saved as artifact** — `kind: 'review'`, `status: 'pending'`, `source: 'mcp'`, no tags. Title: `YYYY-MM-DD — Evening Checkin`. Just markdown text, no structured metadata. Claude reads past reviews as text to detect trends. Espejo-only — no sync to Day One.

6. **Simplified Spanish** — "Conduct in B1 Spanish." No complex progressive-immersion rules.

7. **Flexible output format** — Claude writes the entry in the user's voice based on what emerged. Must include system state and boundary score. No rigid section template.

8. **No configurable parameters for v1** — Fixed 7-day window. No knobs. YAGNI.

## Context Bundle Shape

The prompt handler returns messages containing:

```
1. SYSTEM PROMPT
   - Evening review personality and process instructions
   - Three-system model explanation
   - Weight guideline ranges
   - "Conduct in B1 Spanish"
   - Output guidance: write in user's voice, must include system state + boundary score, find own shape
   - Instruction to call save_evening_review at the end

2. JOURNAL ENTRIES (last 7 days)
   - Formatted entries with dates, tags, weather, text
   - Ordered chronologically
   - (Morning entries will contain self-reported system states — valuable for trend comparison)

3. PAST REVIEWS (last 7 days, from artifacts kind='review')
   - If present: formatted review entries showing system state trends
   - If absent: "No evening reviews found in the last 7 days."

4. OURA BIOMETRICS (weekly analysis)
   - Pre-computed weekly summary with averages and trends
   - Sleep scores, HRV, readiness, activity

5. WEIGHT DATA (last 7 days)
   - Weight trend for the week against the guideline ranges
   - (72.5-73.5 ideal / <75 acceptable / 75-77 danger / >77 red)
```

## Resolved Questions

1. **Weight data** — Weight is tracked in a dedicated DB table. The prompt handler queries the last 7 days of weight readings to show the trend alongside the weight guideline ranges.

2. **Review artifact format** — Just markdown. No structured metadata for system states or boundary scores. Claude reads the text from past reviews to detect trends. Keeps the save tool dead simple.

3. **Oura context depth** — Pre-computed weekly analysis (like `get_oura_weekly`). More concise, saves tokens, Claude gets the signal without doing math. No raw daily summaries.

4. **"Last review" gap detection** — No look-back beyond the 7-day window. Just report "no reviews in last 7 days" if none found. Keep it simple.

5. **Architecture** — MCP Prompt (registerPrompt) for session start, MCP Tool for save. Explored registerResource (too static, still needs tool call) and tool-only (puts system prompt in tool output instead of system slot).

6. **Personality** — Load-bearing for ADHD engagement, not decorative. Sass/directness creates novelty and emotional texture that prevents disengagement.

7. **Spanish** — Simplified to "conduct in B1 Spanish." User reads Spanish fine, responds in English when tired.

8. **Output format** — Flexible. Must include system state + boundary score. Claude decides the rest based on what emerged. Original 8-section template was over-specified.

9. **Three-system model** — Core framework, keep it. Morning entries also contain self-reported states, giving Claude both self-assessment and data to validate trends.
