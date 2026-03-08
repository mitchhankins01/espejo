# Project Management — ADHD-Tailored Project Management

## Status: Stub (awaiting spec worker)

## What

Extend the todo system into proper project management, designed specifically for ADHD workflows. Anchor use case: "Move to Spain" (visa, housing, banking, shipping, flights, insurance, address changes...).

## Scope

- **Dependencies/blocking**: Between todos (current system only has parent/child hierarchy)
- **Milestones and timeline**: Soft deadlines, not hard — ADHD-friendly
- **Breakdown assistance**: LLM helps decompose a big project into manageable steps
- **Progress tracking**: Momentum visualization, streak-like motivation
- **ADHD-specific features**:
  - Body doubling prompts ("I'll work on this with you")
  - Transition support ("wrapping up X, let's shift to Y")
  - "Just start" nudges (smallest possible next action)
  - Celebration of progress (not just completion)
  - Energy-aware scheduling (match task difficulty to energy level)

## Key Questions

- What's the right complexity level? Full Gantt chart is overkill, flat list is insufficient
- Should dependencies be hard (blocks) or soft (suggested order)?
- How does the Telegram bot interact with projects? Daily standup? Progress nudges?
- Web app changes needed: project view, timeline/kanban, dependency visualization?
- How does this integrate with proactive check-ins (spec 4)?
- What's the data model? New `projects` table? Or just richer todo relationships?
- How to handle the ADHD tendency to over-plan and under-execute? (Keep planning lightweight)

## Context Budget Note

Project state injection into Telegram could be verbose. This spec must define:
- How project context is summarized (e.g., "3/12 steps done, next: X, blocked by: Y")
- Whether full project tree is ever injected or always summarized
- Token budget for project context section

## Dependencies

- **Proactive Check-ins** (spec 4) — check-ins can track project progress
- **Memory v2** (spec 3) — project context is part of agent memory
- Can proceed independently since it extends existing todo system

## Existing Code to Reuse

| Component | Location | What to reuse |
|-----------|----------|---------------|
| Todo CRUD | `db/queries.ts` | Existing todo queries to extend |
| Todo tools | `src/tools/create-todo.ts`, etc. | MCP tool pattern |
| Todo context | `todos/context.ts` | Context injection to extend with project awareness |
| Web app todo pages | `web/src/pages/Todo*.tsx` | UI to extend with project views |
| Eisenhower matrix | `web/src/components/EisenhowerMatrix.tsx` | Quadrant logic |
| REST API | `src/transports/http.ts` | Todo endpoints to extend |

## Data Model Ideas

### Option A: Projects as a new entity
```
projects table:
  id, title, description, status, deadline (soft), created_at, updated_at

project_todos junction:
  project_id, todo_id, order, dependency_type
```

### Option B: Extend existing todos
```
todos table additions:
  - depends_on_id (FK to todos) — soft dependency
  - milestone BOOLEAN — marks key checkpoints
  - deadline DATE — soft, ADHD-friendly
  - energy_level ENUM (low, medium, high) — match to energy state
```

### Option C: Hybrid
Top-level todos become "projects" when they have children. Add dependency edges between sibling todos. No new table needed.

## ADHD Design Principles

1. **Lowest friction wins** — adding a task should be as easy as sending a message
2. **Next action, always visible** — never show a wall of tasks, surface THE one thing
3. **Progress is visible** — show momentum, not just remaining work
4. **Flexible, not rigid** — soft deadlines, reorderable, no guilt for rescheduling
5. **Energy-aware** — suggest tasks that match current energy level
6. **Celebration built in** — acknowledge completions, streaks, milestones

## Open Design Decisions

- [ ] Data model: new table vs extended todos vs hybrid
- [ ] Dependency type: hard blocks vs soft suggestions
- [ ] Timeline: date-based vs sequence-based vs none
- [ ] Web app: project view design (list? kanban? timeline? dependency graph?)
- [ ] Telegram interaction: how does the bot surface project context naturally?
- [ ] LLM breakdown: how to prompt for good task decomposition
- [ ] Energy matching: manual energy input or inferred from Oura data?
