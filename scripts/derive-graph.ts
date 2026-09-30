#!/usr/bin/env bun
/**
 * Derive a viewer-ready call graph from a (fork) scip-typescript JSON index.
 *
 * Faithful TypeScript port of `rules/scip/derive-graph.py`. Reads a SCIP JSON
 * index (`index-fork.json` style) and writes the frozen `gpen-scip-graph/1`
 * shape consumed by the global / local views.
 *
 * Upgrades over the Python original:
 *   - Uses `SymbolInformation.display_name` when present (fork index), and only
 *     falls back to the symbol-doc / symbol-string name logic when it is absent.
 *   - Emits `range` per node from the definition occurrence's SCIP range
 *     (`[line, startChar, endChar]` or `[startLine, startChar, endLine, endChar]`,
 *     0-based columns) as 1-based `{start,end}` positions (reserved for
 *     jump-to-source).
 *
 * Usage:
 *   bun scripts/derive-graph.ts --scip <index.json> --out <graph.json>
 *   bun run derive -- --scip /path/index-fork.json --out static/graph.json
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { SG_SCHEMA, type SgEdge, type SgGraph, type SgNode, type SgRange } from '../src/lib/graph/schema';

// ---------------------------------------------------------------------------
// SCIP constants
// ---------------------------------------------------------------------------

/** SCIP `SymbolRole.Definition`. */
const ROLE_DEFINITION = 1;
/** SCIP `SyntaxKind.IdentifierFunction` (fork src/scip.ts). */
const SYNTAX_IDENTIFIER_FUNCTION = 15;

/** SCIP `SymbolInformation.Kind` (fork src/scip.ts Kind enum). */
const KIND_FUNCTION = 17;
const KIND_METHOD = 26;
const KIND_STATIC_METHOD = 80;
const KIND_GETTER = 18;
const KIND_SETTER = 45;
const KIND_CONSTRUCTOR = 9;
const KIND_INTERFACE = 21;
const KIND_CLASS = 7;
const KIND_TYPE_ALIAS = 55;
const KIND_ENUM = 11;
const KIND_STRUCT = 49;
const KIND_MODULE = 16;
const KIND_ABSTRACT_METHOD = 81;
const KIND_PROPERTY = 41;
const KIND_CONSTANT = 8;
const KIND_VARIABLE = 12;
const KIND_PARAMETER = 43;

const KIND_NAMES: Record<number, string> = {
  [KIND_CLASS]: 'Class',
  [KIND_CONSTANT]: 'Constant',
  [KIND_CONSTRUCTOR]: 'Constructor',
  [KIND_ENUM]: 'Enum',
  [KIND_VARIABLE]: 'Variable',
  [KIND_MODULE]: 'Module',
  [KIND_FUNCTION]: 'Function',
  [KIND_GETTER]: 'Getter',
  [KIND_INTERFACE]: 'Interface',
  [KIND_METHOD]: 'Method',
  [KIND_PROPERTY]: 'Property',
  [KIND_PARAMETER]: 'Parameter',
  [KIND_SETTER]: 'Setter',
  [KIND_STRUCT]: 'Struct',
  [KIND_TYPE_ALIAS]: 'TypeAlias',
  [KIND_STATIC_METHOD]: 'StaticMethod',
  [KIND_ABSTRACT_METHOD]: 'AbstractMethod',
};

/** Kinds that are "weak" enough to be replaced by a concrete definition. */
function isWeakKind(kind: number): boolean {
  return kind === 0 || kind === KIND_MODULE;
}

// ---------------------------------------------------------------------------
// SCIP JSON shape (subset we read)
// ---------------------------------------------------------------------------

interface ScipSymbolInformation {
  symbol?: string;
  kind?: number;
  documentation?: string[];
  /** Present on the fork index (snake_case JSON). */
  display_name?: string;
}

interface ScipOccurrence {
  range: number[];
  symbol?: string;
  symbol_roles?: number;
  syntax_kind?: number;
  enclosing_range?: number[];
}

interface ScipDocument {
  language?: string;
  relative_path: string;
  occurrences?: ScipOccurrence[];
  symbols?: ScipSymbolInformation[];
}

interface ScipIndex {
  metadata?: { tool_info?: { name?: string; version?: string } };
  documents: ScipDocument[];
}

// ---------------------------------------------------------------------------
// String helpers (mirror Python str.split/rsplit semantics)
// ---------------------------------------------------------------------------

/** `str.split(sep, maxParts - 1)` semantics: keep the remainder in the last slot. */
function splitMax(value: string, sep: string, maxParts: number): string[] {
  const parts = value.split(sep);
  if (parts.length <= maxParts) return parts;
  return [...parts.slice(0, maxParts - 1), parts.slice(maxParts - 1).join(sep)];
}

/** `str.rsplit(sep, 1)[-1]`. */
function rsplitLast(value: string, sep: string): string {
  const index = value.lastIndexOf(sep);
  return index < 0 ? value : value.slice(index + sep.length);
}

/** `str.split(sep, maxsplit)[-1]` (last token / remainder). */
function lastSpaceToken(symbol: string): string {
  const parts = splitMax(symbol, ' ', 5);
  return parts[parts.length - 1];
}

const IS_LOCAL = (symbol: string): boolean => symbol.startsWith('local ');

function isSvelteFile(path: string): boolean {
  return path.endsWith('.svelte');
}

const DESCRIPTOR_PARAM_RE = /(\([^)]*\))+/g;
const DOC_NAME_RE =
  /(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)|([A-Za-z0-9_$]+)\s*\([^)]*\)\s*(?::|=>|\{)/;

/** Pull a symbol name from its SCIP `documentation` signature block. */
function nameFromDoc(doc: string): string {
  for (const raw of doc.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('```')) continue;
    const match = DOC_NAME_RE.exec(line);
    if (match) return match[1] || match[2] || '';
    break;
  }
  return '';
}

/** Best-effort human name from an SCIP symbol string (fallback path). */
function symbolName(symbol: string, file: string): string {
  if (IS_LOCAL(symbol)) return symbol;
  const parts = splitMax(symbol, ' ', 5);
  const desc = parts.length === 5 ? parts[4] : symbol;
  let last = rsplitLast(desc, '/');
  last = last.replace(DESCRIPTOR_PARAM_RE, '');
  last = last.replace(/[.:#]+$/, '');
  last = rsplitLast(last, '#');
  last = rsplitLast(last, '.');
  last = last.split('[', 1)[0];
  return last || rsplitLast(file, '/');
}

/** Convert an SCIP range to a 1-based `SgRange` (or undefined when malformed). */
export function scipRangeToSg(range: number[] | undefined): SgRange | undefined {
  if (!range || range.length < 3) return undefined;
  if (range.length >= 4) {
    const [startLine, startChar, endLine, endChar] = range;
    return {
      start: { line: startLine + 1, column: startChar + 1 },
      end: { line: endLine + 1, column: endChar + 1 },
    };
  }
  const [line, startChar, endChar] = range;
  return {
    start: { line: line + 1, column: startChar + 1 },
    end: { line: line + 1, column: endChar + 1 },
  };
}

// ---------------------------------------------------------------------------
// Core analysis
// ---------------------------------------------------------------------------

interface SymbolMeta {
  kind: number;
  doc: string;
  displayName?: string;
}

interface Definition {
  file: string;
  line: number;
}

function localKey(file: string, symbol: string): string {
  return `${file}\u0000${symbol}`;
}

/** Compare `(file, line)` tuples like Python's tuple ordering. */
function compareDefinition(a: Definition, b: Definition): number {
  if (a.file !== b.file) return a.file < b.file ? -1 : 1;
  return a.line - b.line;
}

/** Derive the graph from an already-parsed SCIP index. Pure. */
export function analyze(index: ScipIndex, sourceLabel = 'index'): SgGraph {
  const docs = index.documents ?? [];

  // Document-scoped symbol metadata (local symbols are file-scoped).
  const localMeta = new Map<string, SymbolMeta>();
  const globalMeta = new Map<string, SymbolMeta>();
  const typeKind = new Map<string, number>();
  for (const doc of docs) {
    const file = doc.relative_path;
    for (const info of doc.symbols ?? []) {
      const symbol = info.symbol;
      if (!symbol) continue;
      const meta: SymbolMeta = {
        kind: info.kind ?? 0,
        doc: (info.documentation ?? []).join('\n'),
        displayName: info.display_name,
      };
      if (IS_LOCAL(symbol)) {
        localMeta.set(localKey(file, symbol), meta);
      } else {
        globalMeta.set(symbol, meta);
        const desc = lastSpaceToken(symbol);
        if (desc.endsWith('#')) typeKind.set(symbol, meta.kind);
      }
    }
  }

  const metaOf = (file: string, symbol: string): SymbolMeta | undefined =>
    IS_LOCAL(symbol) ? localMeta.get(localKey(file, symbol)) : globalMeta.get(symbol);

  const kindOf = (file: string, symbol: string): number => metaOf(file, symbol)?.kind ?? 0;

  /** Kind of the type that owns this member symbol (for dispatch inference). */
  const enclosingTypeKind = (symbol: string): number => {
    const desc = lastSpaceToken(symbol);
    const idx = desc.lastIndexOf('#');
    if (idx < 0) return 0;
    const head = desc.slice(0, idx);
    const prefix = symbol.slice(0, symbol.length - desc.length) + head + '#';
    return typeKind.get(prefix) ?? 0;
  };

  // Definition occurrences -> (file, line); node key -> symbol metadata.
  const defsLocal = new Map<string, Definition[]>();
  const defsGlobal = new Map<string, Definition[]>();
  const keyKind = new Map<string, number>();
  const keyName = new Map<string, string>();
  const keyRange = new Map<string, SgRange>();

  const pushDef = (map: Map<string, Definition[]>, key: string, def: Definition): void => {
    const list = map.get(key);
    if (list) list.push(def);
    else map.set(key, [def]);
  };

  for (const doc of docs) {
    const file = doc.relative_path;
    for (const occ of doc.occurrences ?? []) {
      if (!((occ.symbol_roles ?? 0) & ROLE_DEFINITION)) continue;
      const symbol = occ.symbol;
      if (!symbol) continue;
      const line1 = occ.range[0] + 1;
      const key = `${file}:${line1}`;
      const def: Definition = { file, line: line1 };
      pushDef(defsLocal, localKey(file, symbol), def);
      pushDef(defsGlobal, symbol, def);

      const kind = kindOf(file, symbol);
      const meta = metaOf(file, symbol);
      const displayName = meta?.displayName;
      let name = displayName || symbolName(symbol, file);
      if (!displayName && name.startsWith('local ')) {
        name = nameFromDoc(meta?.doc ?? '') || name;
      }

      const prev = keyKind.get(key);
      if (prev === undefined || (isWeakKind(prev) && !isWeakKind(kind))) {
        keyKind.set(key, kind);
        keyName.set(key, name);
        const range = scipRangeToSg(occ.range);
        if (range) keyRange.set(key, range);
      }
    }
  }

  const defKeyScoped = (file: string, symbol: string): string | undefined => {
    const defs = IS_LOCAL(symbol) ? defsLocal.get(localKey(file, symbol)) : defsGlobal.get(symbol);
    if (!defs || defs.length === 0) return undefined;
    let best = defs[0];
    for (const def of defs) if (compareDefinition(def, best) < 0) best = def;
    return `${best.file}:${best.line}`;
  };

  interface MutableEdge {
    from: string;
    to: string;
    calls: number;
    sites: { file: string; line: number; column: number }[];
    virtual: boolean;
  }

  const edges = new Map<string, MutableEdge>();
  for (const doc of docs) {
    const file = doc.relative_path;
    for (const occ of doc.occurrences ?? []) {
      const symbol = occ.symbol;
      if (!symbol) continue;
      if ((occ.symbol_roles ?? 0) & ROLE_DEFINITION) continue;
      if (occ.syntax_kind !== SYNTAX_IDENTIFIER_FUNCTION) continue;
      const enclosing = occ.enclosing_range;
      if (!enclosing || enclosing.length === 0) continue;
      const caller = `${file}:${enclosing[0] + 1}`;
      const callee = defKeyScoped(file, symbol);
      if (callee === undefined) continue;
      const key = `${caller}\u0000${callee}`;
      let edge = edges.get(key);
      if (!edge) {
        edge = { from: caller, to: callee, calls: 0, sites: [], virtual: false };
        edges.set(key, edge);
      }
      edge.calls += 1;
      edge.sites.push({ file, line: occ.range[0] + 1, column: occ.range[1] });
      const ownerKind = enclosingTypeKind(symbol);
      if (ownerKind === KIND_INTERFACE || ownerKind === KIND_ABSTRACT_METHOD) edge.virtual = true;
    }
  }

  // ---- assemble nodes / edges ----
  const nodeIds = new Set<string>();
  for (const edge of edges.values()) {
    nodeIds.add(edge.from);
    nodeIds.add(edge.to);
  }

  for (const id of nodeIds) {
    if (keyKind.has(id)) continue;
    const idx = id.lastIndexOf(':');
    const line = id.slice(idx + 1);
    keyKind.set(id, line === '1' ? KIND_MODULE : 0);
    keyName.set(id, '');
  }

  const degree = new Map<string, number>();
  const bump = (id: string): void => {
    degree.set(id, (degree.get(id) ?? 0) + 1);
  };
  for (const edge of edges.values()) {
    bump(edge.from);
    if (edge.from !== edge.to) bump(edge.to);
  }

  const nodes: SgNode[] = [...nodeIds].sort().map((id) => {
    const idx = id.lastIndexOf(':');
    const file = id.slice(0, idx);
    const line = Number(id.slice(idx + 1));
    const kind = keyKind.get(id) ?? 0;
    const name = keyName.get(id) || symbolName('', file);
    const node: SgNode = {
      id,
      kind: KIND_NAMES[kind] ?? (kind ? 'Other' : 'Unknown'),
      name,
      file,
      line,
      weight: Math.max(1, degree.get(id) ?? 0),
      svelte: isSvelteFile(file),
    };
    const range = keyRange.get(id);
    if (range) node.range = range;
    return node;
  });

  const outEdges: SgEdge[] = [...edges.values()]
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0))
    .map((edge) => ({
      from: edge.from,
      to: edge.to,
      dispatch: edge.from === edge.to ? 'self' : edge.virtual ? 'virtual' : 'static',
      confidence: 1.0,
      calls: edge.calls,
      sites: edge.sites,
    }));

  const kindCounts = new Map<string, number>();
  for (const node of nodes) kindCounts.set(node.kind, (kindCounts.get(node.kind) ?? 0) + 1);
  const kinds: Record<string, number> = {};
  for (const [kind, count] of [...kindCounts.entries()].sort((a, b) => b[1] - a[1])) {
    kinds[kind] = count;
  }

  return {
    schema: SG_SCHEMA,
    source: {
      index: sourceLabel,
      svelte_supported: true,
      scip_tool: index.metadata?.tool_info?.name ?? null,
      scip_tool_version: index.metadata?.tool_info?.version ?? null,
    },
    nodes,
    edges: outEdges,
    stats: {
      nodes: nodes.length,
      edges: outEdges.length,
      self_loops: outEdges.filter((edge) => edge.from === edge.to).length,
      svelte_nodes: nodes.filter((node) => node.svelte).length,
      svelte_edges: outEdges.filter(
        (edge) => edge.from.split(':')[0].endsWith('.svelte') || edge.to.split(':')[0].endsWith('.svelte'),
      ).length,
      virtual_edges: outEdges.filter((edge) => edge.dispatch === 'virtual').length,
      call_sites: outEdges.reduce((sum, edge) => sum + edge.calls, 0),
      kinds,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const DEFAULT_SCIP = 'rules/out/.cache/scip/index-fork.json';
const DEFAULT_OUT = 'static/graph.json';

const USAGE = `scip-graph derive — SCIP JSON index -> gpen-scip-graph/1

Usage:
  bun scripts/derive-graph.ts --scip <index.json> --out <graph.json> [--pretty]

Options:
  --scip <path>    input SCIP JSON index (default: ${DEFAULT_SCIP})
  --out <path>     output graph JSON (default: ${DEFAULT_OUT})
  --pretty         pretty-print the output JSON (2-space indent)
  -h, --help       show this help

Example:
  bun run derive -- --scip /path/to/index-fork.json --out static/graph.json
`;

interface CliOptions {
  scip: string;
  out: string;
  pretty: boolean;
  help: boolean;
}

class UsageError extends Error {}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { scip: DEFAULT_SCIP, out: DEFAULT_OUT, pretty: false, help: false };
  const takeValue = (flag: string, inline: string | undefined, next: () => string | undefined): string => {
    if (inline !== undefined) return inline;
    const value = next();
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
    return value;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq >= 0 ? arg.slice(0, eq) : arg;
    const inline = eq >= 0 ? arg.slice(eq + 1) : undefined;
    if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else if (flag === '--pretty') {
      options.pretty = true;
    } else if (flag === '--scip') {
      options.scip = takeValue(flag, inline, () => argv[++i]);
    } else if (flag === '--out') {
      options.out = takeValue(flag, inline, () => argv[++i]);
    } else if (flag.startsWith('-')) {
      throw new UsageError(`unknown option: ${arg}`);
    } else {
      throw new UsageError(`unexpected argument: ${arg}`);
    }
  }
  return options;
}

export function runCli(argv: string[]): number {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const index = JSON.parse(readFileSync(options.scip, 'utf8')) as ScipIndex;
  const graph = analyze(index, basename(options.scip));
  const json = options.pretty ? JSON.stringify(graph, null, 2) : JSON.stringify(graph);
  writeFileSync(options.out, json);
  process.stderr.write(`[scip-graph] wrote ${options.out} from ${options.scip}\n`);
  process.stdout.write(`${JSON.stringify(graph.stats, null, 1)}\n`);
  return 0;
}

const invokedDirectly =
  typeof (import.meta as ImportMeta & { main?: boolean }).main === 'boolean'
    ? (import.meta as ImportMeta & { main?: boolean }).main === true
    : Boolean(process.argv[1]?.includes('derive-graph'));

if (invokedDirectly) {
  try {
    process.exit(runCli(process.argv.slice(2)));
  } catch (error) {
    process.stderr.write(`[scip-graph] error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
