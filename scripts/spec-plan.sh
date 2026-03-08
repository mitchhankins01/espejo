#!/usr/bin/env bash
set -euo pipefail

NAME="${1:?Usage: pnpm spec:plan <name> <description>}"
DESC="${2:?Usage: pnpm spec:plan <name> <description>}"
ROUNDS="${3:-2}"
SPEC="specs/${NAME}.md"

# Allow nested Claude Code invocations
unset CLAUDECODE

echo "=== Spec Planning: ${NAME} ==="
echo "Description: ${DESC}"
echo "Rounds: ${ROUNDS}"
echo "Output: ${SPEC}"
echo ""

# --- Round 1: Claude drafts ---
echo ">>> Round 1: Claude drafting initial spec..."
claude -p "Design a spec for: ${DESC}

Write to ${SPEC}. Follow the format of existing specs in this project
(see specs/todos.md, specs/knowledge-artifacts.md for examples).

Include sections for:
- Context (why this feature, what problem it solves)
- Data model (SQL schema changes if any)
- Query functions (src/db/queries.ts additions)
- MCP tools (if applicable, following specs/tools.spec.ts patterns)
- REST API endpoints (src/transports/http.ts additions)
- Web UI changes (if applicable)
- Telegram integration (if applicable)
- Verification (how to test)

Read CLAUDE.md to understand project conventions." \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --model opus

echo ""

# --- Iterative rounds ---
for i in $(seq 1 "${ROUNDS}"); do
  # Codex reviews
  echo ">>> Round $((i * 2)): Codex reviewing..."
  codex exec "You are reviewing a feature spec for a TypeScript MCP server project.

Read ${SPEC} and review it against the existing codebase.

Your job is to find:
- Missing edge cases or error handling
- Inconsistencies with existing patterns (read CLAUDE.md for conventions)
- Over-engineering (unnecessary abstractions, premature optimization)
- Gaps in the test/verification plan
- Schema issues (missing indexes, wrong constraints, normalization problems)

Revise the spec INLINE to fix issues you find. For each change, add a
<!-- codex: reason --> comment explaining why.

Add a '## Review Notes' section at the end summarizing your key findings." \
    --full-auto \
    --ephemeral

  echo ""

  # Claude responds
  echo ">>> Round $((i * 2 + 1)): Claude responding to review..."
  claude -p "Read ${SPEC}. Codex has reviewed and revised it.

Evaluate every change marked with <!-- codex: reason --> comments.
- Accept changes that improve the spec
- Push back on changes that conflict with project conventions or are wrong
- Remove all <!-- codex: --> markers as you go

If Codex flagged real issues, fix them properly.
If Codex over-corrected, revert and explain why in a brief inline comment.

Remove the '## Review Notes' section — integrate useful feedback into the spec itself.
If anything is genuinely unresolved, add a brief '## Open Questions' section." \
    --permission-mode bypassPermissions \
    --no-session-persistence \
    --model opus

  echo ""
done

# --- Final cleanup ---
echo ">>> Final: Claude finalizing spec..."
claude -p "Finalize ${SPEC}.

- Remove ALL review artifacts: <!-- comments -->, ## Review Notes, ## Open Questions
  (resolve any open questions with your best judgment)
- Ensure consistent formatting and section structure
- Verify it follows project conventions from CLAUDE.md
- The spec should read as a clean, authoritative document ready for implementation

Do NOT add new features or expand scope. Just clean and polish." \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --model opus

echo ""
echo "=== Done. Spec ready at ${SPEC} ==="
