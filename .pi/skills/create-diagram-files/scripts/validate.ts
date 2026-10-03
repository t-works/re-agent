/**
 * Self-contained checker for the diagram file format (see references/schema.md).
 * Reads every *.json in the target directory, validates each against the schema,
 * prints errors (fatal) and warnings (advisory). Exits non-zero on any error.
 *
 * No project imports — this file carries the whole vocabulary and the checks, so
 * the skill can be dropped into any directory tree and run as-is.
 *
 *   npx tsx <this-file> [diagrams-dir]     # dir defaults to ./diagrams
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

// ---- vocabulary (keep in sync with the app's kinds/palette tables) ----
const KNOWN_KINDS = new Set([
  'group', 'task', 'source', 'sink', 'service', 'store', 'decision', 'note', 'generic',
]);
const PALETTE = ['slate', 'blue', 'teal', 'green', 'amber', 'red', 'violet', 'pink'];
const BUDGET = { nodes: 300, edges: 500 };
const URL_SAFE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const isPaletteName = (v: unknown) => typeof v === 'string' && PALETTE.includes(v);

export interface ValidationResult {
  errors: string[];
  warnings: string[];
}

export function validateDiagram(input: unknown, knownIds?: ReadonlySet<string>): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const err = (m: string) => errors.push(m);
  const warn = (m: string) => warnings.push(m);

  if (!isObj(input)) return { errors: ['Diagram root must be a JSON object.'], warnings };

  // ---- meta ----
  const meta = input.meta;
  if (!isObj(meta)) err('meta: missing or not an object.');
  const id = isObj(meta) && typeof meta.id === 'string' ? meta.id : null;
  if (!id) {
    err('meta.id: required string.');
  } else {
    if (!URL_SAFE.test(id)) err(`meta.id "${id}": must be URL-safe (letters, digits, "-", "_").`);
    if (knownIds?.has(id)) err(`meta.id "${id}": duplicate across diagrams.`);
  }
  if (!isObj(meta) || typeof meta.title !== 'string' || meta.title.trim() === '') {
    err('meta.title: required non-empty string.');
  }
  if (isObj(meta) && meta.order !== undefined && typeof meta.order !== 'number') {
    err('meta.order: must be a number when present.');
  }
  if (isObj(meta) && meta.description !== undefined && typeof meta.description !== 'string') {
    err('meta.description: must be a string when present.');
  }

  // ---- direction (top-level wins, meta.direction accepted) ----
  for (const [where, value] of [
    ['direction', input.direction],
    ['meta.direction', isObj(meta) ? meta.direction : undefined],
  ] as const) {
    if (value !== undefined && value !== 'LR' && value !== 'TB') {
      err(`${where}: must be "LR" or "TB".`);
    }
  }

  // ---- nodes ----
  if (!Array.isArray(input.nodes)) {
    err('nodes: must be an array.');
    return { errors, warnings };
  }

  const nodeIndex = new Map<string, number>();
  const nodeById = new Map<string, Record<string, unknown>>();

  input.nodes.forEach((raw, i) => {
    const at = `nodes[${i}]`;
    if (!isObj(raw)) {
      err(`${at}: must be an object.`);
      return;
    }
    const nid = typeof raw.id === 'string' ? raw.id : null;
    if (!nid) err(`${at}.id: required string.`);
    else if (nodeIndex.has(nid)) err(`${at}.id "${nid}": duplicate within this diagram.`);
    else nodeIndex.set(nid, i);

    if (typeof raw.kind !== 'string' || raw.kind === '') {
      err(`${at}.kind: required string.`);
    } else if (!KNOWN_KINDS.has(raw.kind)) {
      warn(`${at}.kind "${raw.kind}": unknown, falling back to "generic".`);
    }
    if (typeof raw.label !== 'string' || raw.label.trim() === '') {
      err(`${at}.label: required non-empty string.`);
    }
    if (raw.color !== undefined && !isPaletteName(raw.color)) {
      warn(`${at}.color "${String(raw.color)}": not in the palette, using the kind default.`);
    }

    if (raw.size !== undefined) {
      if (!isObj(raw.size)) err(`${at}.size: must be an object.`);
      else {
        const { width, height } = raw.size;
        if (typeof width !== 'number' || width <= 0) err(`${at}.size.width: must be a positive number.`);
        if (typeof height !== 'number' || height <= 0) err(`${at}.size.height: must be a positive number.`);
      }
    }

    if (raw.parent !== undefined && typeof raw.parent !== 'string') {
      err(`${at}.parent: must be a string.`);
    }

    for (const slot of ['inputs', 'outputs'] as const) {
      const ports = raw[slot];
      if (ports === undefined) continue;
      if (!Array.isArray(ports)) {
        err(`${at}.${slot}: must be an array.`);
        continue;
      }
      const seen = new Set<string>();
      ports.forEach((p, j) => {
        if (!isObj(p) || typeof p.id !== 'string' || p.id === '') {
          err(`${at}.${slot}[${j}].id: required string.`);
        } else if (seen.has(p.id)) {
          err(`${at}.${slot}[${j}].id "${p.id}": duplicate.`);
        } else seen.add(p.id);
      });
    }

    if (raw.sections !== undefined) {
      if (!Array.isArray(raw.sections)) {
        err(`${at}.sections: must be an array.`);
      } else {
        const seen = new Set<string>();
        raw.sections.forEach((s, j) => {
          if (!isObj(s) || typeof s.id !== 'string' || s.id === '') {
            err(`${at}.sections[${j}].id: required string.`);
            return;
          }
          if (seen.has(s.id)) err(`${at}.sections[${j}].id "${s.id}": duplicate.`);
          seen.add(s.id);
          if (typeof s.label !== 'string' || s.label.trim() === '') {
            err(`${at}.sections[${j}].label: required non-empty string.`);
          }
          if (s.items !== undefined && !(Array.isArray(s.items) && s.items.every((x) => typeof x === 'string'))) {
            err(`${at}.sections[${j}].items: must be an array of strings.`);
          }
        });
      }
    }

    if (nid) nodeById.set(nid, raw);
  });

  // ---- parent references + ordering ----
  input.nodes.forEach((raw, i) => {
    if (!isObj(raw) || typeof raw.parent !== 'string') return;
    const parentIndex = nodeIndex.get(raw.parent);
    if (parentIndex === undefined) {
      err(`nodes[${i}].parent "${raw.parent}": does not resolve to a node.`);
    } else if (parentIndex > i) {
      err(`nodes[${i}].parent "${raw.parent}": parent must appear before its children.`);
    }
  });

  // ---- edges ----
  const edgeIds = new Set<string>();
  const edges = input.edges;
  if (edges !== undefined && !Array.isArray(edges)) {
    err('edges: must be an array.');
  } else if (Array.isArray(edges)) {
    edges.forEach((raw, i) => {
      const at = `edges[${i}]`;
      if (!isObj(raw)) {
        err(`${at}: must be an object.`);
        return;
      }
      const source = typeof raw.source === 'string' ? raw.source : null;
      const target = typeof raw.target === 'string' ? raw.target : null;
      if (!source) err(`${at}.source: required string.`);
      if (!target) err(`${at}.target: required string.`);

      const src = source ? nodeById.get(source) : undefined;
      const tgt = target ? nodeById.get(target) : undefined;
      if (source && !src) err(`${at}.source "${source}": does not resolve to a node.`);
      if (target && !tgt) err(`${at}.target "${target}": does not resolve to a node.`);

      const portId = (node: Record<string, unknown> | undefined, slot: string, name: string, nodeId: string | null) => {
        if (!node) return;
        const ports = Array.isArray(node[slot]) ? (node[slot] as unknown[]) : [];
        const ids = ports.filter(isObj).map((p) => p.id).filter((x): x is string => typeof x === 'string');
        if (name && !ids.includes(name)) {
          err(`${at}.${slot === 'outputs' ? 'sourcePort' : 'targetPort'} "${name}": not a port on "${nodeId}".`);
        }
        if (!name && ids.length === 0) {
          err(`${at}: "${nodeId}" has no ${slot}; declare ${slot} on that node or add an explicit port reference.`);
        }
      };
      portId(src, 'outputs', typeof raw.sourcePort === 'string' ? raw.sourcePort : '', source);
      portId(tgt, 'inputs', typeof raw.targetPort === 'string' ? raw.targetPort : '', target);

      const eid = typeof raw.id === 'string' ? raw.id : null;
      if (eid) {
        if (edgeIds.has(eid)) err(`${at}.id "${eid}": duplicate.`);
        else edgeIds.add(eid);
      }

      if (raw.variant !== undefined && !['default', 'dashed', 'animated'].includes(String(raw.variant))) {
        err(`${at}.variant: must be "default", "dashed" or "animated".`);
      }
      if (source && target && source === target) warn(`${at}: self-loop ("${source}").`);
    });
  }

  // ---- budget ----
  const nodeCount = input.nodes.length;
  const edgeCount = Array.isArray(edges) ? edges.length : 0;
  if (nodeCount > BUDGET.nodes) {
    warn(`Large diagram: ${nodeCount} nodes exceeds the ${BUDGET.nodes}-node budget; rendering may be slow.`);
  }
  if (edgeCount > BUDGET.edges) {
    warn(`Large diagram: ${edgeCount} edges exceeds the ${BUDGET.edges}-edge budget; rendering may be slow.`);
  }

  return { errors, warnings };
}

// ---- CLI ----
function main() {
  const dir = resolve(process.cwd(), process.argv[2] ?? 'diagrams');

  interface Entry {
    file: string;
    data: unknown;
    parseError: string | null;
  }

  let entries: Entry[];
  try {
    entries = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((file) => {
        try {
          return { file, data: JSON.parse(readFileSync(join(dir, file), 'utf8')) as unknown, parseError: null };
        } catch (e) {
          return { file, data: null, parseError: e instanceof Error ? e.message : String(e) };
        }
      });
  } catch {
    console.error(`No diagram directory at ${dir}`);
    process.exit(1);
  }

  const ids = entries.map(({ file, data }) =>
    isObj(data) && isObj(data.meta) && typeof data.meta.id === 'string'
      ? data.meta.id
      : file.replace(/\.json$/, ''),
  );

  let failed = false;
  entries.forEach((entry, i) => {
    if (entry.parseError) {
      console.error(`✗ ${entry.file}\n    JSON parse error: ${entry.parseError}`);
      failed = true;
      return;
    }
    const knownIds = new Set(ids.filter((_, j) => j !== i));
    const { errors, warnings } = validateDiagram(entry.data, knownIds);
    if (errors.length === 0 && warnings.length === 0) {
      console.log(`✓ ${entry.file}`);
      return;
    }
    console.log(`${errors.length > 0 ? '✗' : '!'} ${entry.file}`);
    for (const m of errors) console.log(`    error: ${m}`);
    for (const m of warnings) console.log(`    warn:  ${m}`);
    if (errors.length > 0) failed = true;
  });

  console.log(`\n${entries.length} diagram(s) checked.`);
  process.exit(failed ? 1 : 0);
}

// ---- self-check: `npx tsx scripts/validate.ts --self-test` ----
if (process.argv[2] === '--self-test') {
  const assert = (cond: unknown, msg: string) => {
    if (!cond) throw new Error(`self-test failed: ${msg}`);
  };
  const ok = validateDiagram({
    meta: { id: 'ok', title: 'Ok' },
    nodes: [
      { id: 'a', kind: 'source', label: 'A', outputs: [{ id: 'out' }] },
      { id: 'b', kind: 'sink', label: 'B', inputs: [{ id: 'in' }] },
    ],
    edges: [{ source: 'a', target: 'b' }],
  });
  assert(ok.errors.length === 0 && ok.warnings.length === 0, `clean diagram reported ${JSON.stringify(ok)}`);

  const bad = validateDiagram({
    meta: { id: 'not url safe!', title: '' },
    nodes: [
      { id: 'b', kind: 'nope', label: 'B', color: 'chartreuse', parent: 'missing' },
      { id: 'a', kind: 'task', label: 'A' },
    ],
    edges: [{ source: 'a', target: 'ghost' }, { source: 'a', target: 'b', variant: 'wobble' }],
  }, new Set(['not url safe!']));
  assert(bad.errors.length >= 5, `expected several errors, got ${bad.errors.length}`);
  assert(bad.warnings.length === 2, `expected 2 warnings, got ${JSON.stringify(bad.warnings)}`);
  console.log('self-test ok');
} else {
  main();
}
