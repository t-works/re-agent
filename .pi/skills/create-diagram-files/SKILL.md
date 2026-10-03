---
name: create-diagram-files
description: Turn a body of knowledge (PRD, repo, spec, process) into a rendered, auto-laid-out diagram by writing one JSON file. Use when the user asks to visualize, diagram, map, or chart a pipeline, architecture, taxonomy, state machine or flow.
---

## Read these before writing

- `references/schema.md` — the full envelope, kind vocabulary, palette and defaults.
- `assets/*.json` — worked examples (LR with groups, TB topology, state machine).

## Output directory (parameter)

The directory is a parameter, not a constant:

- Invoked with an argument (e.g. `/skill:create-diagram-files docs/diagrams`) →
  use that directory.
- No argument → default to `diagrams/`.

Substitute it for `<diagrams-dir>` everywhere below.

## Rules

1. One diagram per file. `meta.id` is the filename stem, unique and URL-safe.
2. **No coordinates and no sizes.** Layout is automatic. Only set `size` to force a
   `group` or `note` larger than its content — a rare, deliberate act.
3. Ids are unique: `meta.id` across files, `node.id` within the file, `section.id`
   within a node, ports within their slot.
4. A `parent` node must appear **before** its children in `nodes`.
5. Every `parent`, `source`, `target`, `sourcePort`, `targetPort` must resolve to
   something that exists.
6. `kind` must come from the fixed vocabulary. Unknown kinds fall back to `generic`.
7. `color` is a **palette name only** (`slate blue teal green amber red violet pink`),
   and only when it carries meaning (failure path, store, healthy). Everything is
   readable without any color.
8. Keep `label` short. Put detail in `sections` (`items: string[]`), not in the label.
9. `meta.description` is the page header and the legend: one or two sentences on
   what the diagram shows.
10. Stay inside the budget: ≤ 300 nodes, ≤ 500 edges. Past that the page warns.

## Output path

`<diagrams-dir>/<meta.id>.json`

## Then validate — mandatory

The skill ships its own CLI at `scripts/validate.ts` — self-contained, no
project imports, so it works anywhere the skill is copied. Run it from the
target project root after writing, and again after every fix:

```sh
npx tsx <skill-dir>/scripts/validate.ts <diagrams-dir>   # <diagrams-dir> defaults to diagrams/
```

Errors block rendering and must be fixed; warnings are advisory (unknown color,
unknown kind, large diagram). Fix every error and re-run until clean. Then stop.

Sanity-check the checker itself with `npx tsx <skill-dir>/scripts/validate.ts
--self-test`.
