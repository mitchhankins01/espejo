whatsapp chat bot, like a sassy aunt with a touch of stern/jester abuela ayahausaca energy who caoches me throughout the day, keeps me entertained/intruiged/captivated and observes me, gudies me, and accompanies me. 


calendar integration, not just read events put also put reminders on there


social mcp, whatsapp/signal/email/imessage/instagram



Read the full README.md to understand the project. Then create a new file `specs/web-app.spec.md` that documents the spec-driven development harness plan for the future SvelteKit frontend. This is documentation only — do not scaffold or implement anything.

The spec should cover:

**Monorepo structure** — how the SvelteKit app (`web/`) sits alongside the existing MCP server (`src/`), with a `shared/` directory for types that both import from. Use `pnpm-workspace.yaml` for workspace management.

**Shared types as the contract** — a `shared/types.ts` that defines `JournalEntry`, `EntryLocation`, `EntryWeather`, `MoodTag`, `Tag`, `SearchResult`, `EntryStats`. Derive these from the existing database schema and MCP tool return types already in the codebase. Include the actual type definitigitons in the spec so they serve as the source of truth.

**Check script harness** — the web app gets `pnpm check` (svelte-kit sync → svelte-check → eslint → vitest) and `pnpm check:e2e` (playwright). Root package.json gets workspace-level `pnpm -r check`. Same closed feedback loop pattern as the existing MCP server's `pnpm check`.

**Playwright e2e test specs** — define the test files and what each covers: `entry-create.spec.ts`, `entry-list.spec.ts`, `entry-edit.spec.ts`, `entry-delete.spec.ts`, `entry-metadata.spec.ts`. Include example test signatures showing what "done" looks like for Phase 1. Tests run against the existing test database on port 5433.

**Histoire component stories** — list the core components and their story variants: EntryEditor (empty, editing, read-only), EntryList (with entries, empty, loading), EntryCard, TagInput, MoodPicker.

**vitest unit test specs** — entry store CRUD, autosave debounce logic, Tiptap JSON to plain text extraction, date formatting utils.

**Stack** — SvelteKit, Tiptap (svelte-tiptap), Tailwind CSS v4, shared PostgreSQL, Playwright, Histoire, vitest. Capacitor noted as a future addition that the architecture should not preclude.

**Development phases** — Phase 1 (Write & Read), Phase 2 (Search & Browse), Phase 3 (Reflect), Phase 4 (PWA & Polish). Only Phase 1 should be fully specced out. Phases 2-4 get brief descriptions.

Also update the README.md to reference this new spec file in the Web App section, something like "See `specs/web-app.spec.md` for the full frontend development spec."

Match the tone and thoroughness of the existing README and specs in the project.