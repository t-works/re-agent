# Diagram schema

Every file is one diagram. Only `meta.id`, `meta.title` and `nodes` are required.
**There are no coordinates.** Layout is automatic.

```jsonc
{
  "specVersion": "1",
  "meta": {
    "id": "preprocess-pipeline",   // required, unique, URL-safe, = filename stem
    "title": "Preprocess Pipeline",// required, shown in the topbar
    "order": 10,                   // optional topbar sort key
    "description": "How raw data becomes training tensors." // page header + legend
  },
  "direction": "LR",               // "LR" | "TB" (default "LR")
  "nodes": [
    {
      "id": "load",                // unique within the file
      "kind": "task",              // fixed vocabulary, see below
      "label": "Load",
      "color": "green",            // optional palette name
      "parent": "pre",             // optional -> nest inside a group node
      "size": { "width": 140, "height": 64 },  // optional override; rarely needed
      "inputs": [{ "id": "in", "label": "raw" }],
      "outputs": [{ "id": "out", "label": "data" }],
      "sections": [                // optional expandable detail
        { "id": "files", "label": "Files", "open": true, "items": ["raw.csv"] }
      ]
    },
    {
      "id": "pre",
      "kind": "group",
      "label": "Preprocess",
      "color": "violet"
      // groups size themselves to their children
    }
  ],
  "edges": [
    {
      "id": "e-load-norm",         // optional; synthesized when omitted
      "source": "load",
      "sourcePort": "out",         // optional; defaults to the first output
      "target": "norm",
      "targetPort": "in",          // optional; defaults to the first input
      "label": "raw",
      "variant": "default"         // "default" | "dashed" | "animated"
    }
  ]
}
```

## Invariants

- `meta.id` unique across files; `node.id` unique within a file.
- Every `parent`, `source`, `target`, `sourcePort`, `targetPort` resolves.
- A parent node appears **before** its children (React Flow ordering).
- `section.id` unique within a node.
- A `group` sizes itself to its children unless `size` is given.

## Defaults — an omitted field is never an error

| Field | Default |
|---|---|
| `direction` | `"LR"` |
| `edge.variant` | `"default"` |
| `section.open` | `false` |
| `sourcePort` / `targetPort` | the node's first `output` / `input` |
| `node.size` | the kind's default size |
| `node.color` | the kind's default color |

A `color` outside the palette is a **warning**: the node renders with its kind's
default color. Unknown colors never block a render.

## Kind vocabulary

| kind | purpose | slots | default size | default color |
|---|---|---|---|---|
| `group` | container/lane, nests children | — | derived from children | `slate` |
| `task` | generic step | in/out | 140×64 | `blue` |
| `source` | input, dataset, entry point | out | 140×56 | `green` |
| `sink` | output, report, exit point | in | 140×56 | `amber` |
| `service` | long-running component | in/out | 160×72 | `teal` |
| `store` | db / cache / bucket | in/out | 140×64 | `violet` |
| `decision` | branch point | in/out | 120×72 | `pink` |
| `note` | annotation, no connections | — | 160×56 | `slate` |
| `generic` | fallback for unknown kinds | in/out | 140×64 | `slate` |

## Palette

`slate` · `blue` · `teal` · `green` · `amber` · `red` · `violet` · `pink`

A palette name, never a hex value. Every kind has a default, so a diagram with no
`color` at all still reads well. Color overrides the default and is how you encode
semantics: green for healthy, red for a failure path, violet for stores. Children
do **not** inherit their group's color.

## Budget

| Nodes | Behaviour |
|---|---|
| ≤ 300 | target |
| 300–1000 | degraded; culling enabled, rendering slows |
| > 1000 | out of scope |

Exceeding `300` nodes or `500` edges is a validation **warning**: the diagram still
renders, with a large-diagram notice on the page.
