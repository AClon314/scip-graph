/**
 * Unresolved-call boundaries.
 *
 * Reads a (fork) scip-typescript JSON index and keeps occurrences with
 * `syntax_kind == 15` (`IdentifierFunction`) whose callee does not resolve to
 * an in-repo definition. `local N` symbols are resolved per-document, matching
 * `derive-graph.ts` and the SCIP scoped-resolution semantics.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { globToRegExp } from './select';

/** Default fork index, relative to the current working directory. */
export const DEFAULT_INDEX_PATH = 'rules/out/.cache/scip/index-fork.json';

/** SCIP `SymbolRole.Definition` (enum value 1). */
const ROLE_DEFINITION = 1;

/** SCIP `SyntaxKind.IdentifierFunction` (fork `src/scip.ts`, enum value 15). */
const SYNTAX_IDENTIFIER_FUNCTION = 15;

/** runes are compile-time macros whose callee name starts with `$`. */
const RUNE_PREFIX = '$';

// ---------------------------------------------------------------------------
// SCIP JSON shape (subset we read)
// ---------------------------------------------------------------------------

interface ScipOccurrence {
  range: number[];
  symbol?: string;
  symbol_roles?: number;
  syntax_kind?: number;
}

interface ScipDocument {
  relative_path: string;
  occurrences?: ScipOccurrence[];
}

interface ScipIndex {
  documents?: ScipDocument[];
}

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export type BoundaryKind = 'runes' | 'builtins' | 'node_modules' | 'unclassified';

export type BoundaryResult = {
  file: string;
  line: number;
  column: number;
  callee: string;
  symbol: string;
  kind: BoundaryKind;
};

export type BoundaryBreakdown = {
  byKind: Record<string, number>;
  topCallees: { name: string; count: number }[];
};

export type BoundaryData = {
  count: number;
  results: BoundaryResult[];
  breakdown: BoundaryBreakdown | null;
  reason?: string | null;
};

export type BoundaryFilters = {
  symbol?: string | null;
  file?: string | null;
  limit?: number;
};

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** Empty result used when the index is missing (`--json` still emits this, exit 3). */
export function emptyBoundaries(reason: string | null = null): BoundaryData {
  return { count: 0, results: [], breakdown: { byKind: {}, topCallees: [] }, reason };
}

/** Read the fork index and collect boundaries. Missing file → empty result. */
export function loadBoundaries(indexPath: string = resolve(DEFAULT_INDEX_PATH)): BoundaryData {
  if (!existsSync(indexPath)) return emptyBoundaries(`index-missing:${indexPath}`);
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as ScipIndex;
  return collectBoundaries(index);
}

/** Extract boundaries from an already-parsed fork index (pure function). */
export function collectBoundaries(index: ScipIndex): BoundaryData {
  const { defsGlobal, defsLocal } = collectDefinitions(index);
  const results: BoundaryResult[] = [];
  for (const doc of index.documents ?? []) {
    const file = doc.relative_path;
    for (const occurrence of doc.occurrences ?? []) {
      if (occurrence.syntax_kind !== SYNTAX_IDENTIFIER_FUNCTION) continue;
      if ((occurrence.symbol_roles ?? 0) & ROLE_DEFINITION) continue;
      const symbol = occurrence.symbol;
      if (!symbol || resolves(symbol, file, defsGlobal, defsLocal)) continue;
      const callee = symbolDisplayName(symbol);
      results.push({
        file,
        line: occurrence.range[0] + 1,
        column: occurrence.range[1],
        callee,
        symbol,
        kind: classifyBoundary(callee, symbol),
      });
    }
  }
  results.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.column - right.column ||
      left.symbol.localeCompare(right.symbol),
  );
  return { count: results.length, results, breakdown: null };
}

/** Scan definition occurrences: `local N` is document-scoped, the rest global. */
function collectDefinitions(index: ScipIndex): {
  defsGlobal: Set<string>;
  defsLocal: Set<string>;
} {
  const defsGlobal = new Set<string>();
  const defsLocal = new Set<string>();
  for (const doc of index.documents ?? []) {
    const file = doc.relative_path;
    for (const occurrence of doc.occurrences ?? []) {
      if (!((occurrence.symbol_roles ?? 0) & ROLE_DEFINITION)) continue;
      const symbol = occurrence.symbol;
      if (!symbol) continue;
      if (isLocalSymbol(symbol)) defsLocal.add(localKey(file, symbol));
      else defsGlobal.add(symbol);
    }
  }
  return { defsGlobal, defsLocal };
}

function isLocalSymbol(symbol: string): boolean {
  return symbol.startsWith('local ');
}

function localKey(file: string, symbol: string): string {
  return `${file}\u0000${symbol}`;
}

function resolves(
  symbol: string,
  file: string,
  defsGlobal: Set<string>,
  defsLocal: Set<string>,
): boolean {
  return isLocalSymbol(symbol) ? defsLocal.has(localKey(file, symbol)) : defsGlobal.has(symbol);
}

/** Compress a SCIP symbol into a readable callee name (keeps `Type#member`). */
export function symbolDisplayName(symbol: string): string {
  if (!symbol) return '';
  if (isLocalSymbol(symbol)) return symbol;
  const parts = symbol.split(' ');
  let descriptor = parts.length >= 5 ? parts.slice(4).join(' ') : symbol;
  descriptor = descriptor.replace(/[.:#/]+$/, '');
  const lastSlash = descriptor.lastIndexOf('/');
  let tail = lastSlash >= 0 ? descriptor.slice(lastSlash + 1) : descriptor;
  tail = tail.replace(/(\([^)]*\))+/g, '');
  tail = tail.split('[')[0];
  tail = tail.replace(/[.:#]+$/, '');
  return tail || symbol;
}

/** Coarse classification: runes → builtins → node_modules → unclassified. */
export function classifyBoundary(callee: string, symbol: string): BoundaryKind {
  if (callee.startsWith(RUNE_PREFIX)) return 'runes';
  if (/\bnpm typescript\b/.test(symbol) || /\bnpm @types\/node\b/.test(symbol)) return 'builtins';
  if (symbol.startsWith('scip-typescript npm ')) return 'node_modules';
  return 'unclassified';
}

/** Apply `--symbol` / `--file` / `--limit` filters, then rebuild the breakdown. */
export function filterBoundaries(data: BoundaryData, filters: BoundaryFilters = {}): BoundaryData {
  let results = data.results;
  if (filters.symbol) {
    const needle = filters.symbol.toLowerCase();
    results = results.filter((item) => item.callee.toLowerCase().includes(needle));
  }
  if (filters.file) {
    const pattern = globToRegExp(filters.file);
    results = results.filter((item) => pattern.test(item.file));
  }
  const count = results.length;
  const limited = Number.isInteger(filters.limit) ? results.slice(0, filters.limit) : results;
  return { ...data, count, results: limited, breakdown: buildBreakdown(results) };
}

/** Deterministic kind / top-callee aggregation. */
export function buildBreakdown(results: BoundaryResult[]): BoundaryBreakdown {
  const byKind: Record<string, number> = {};
  const callees = new Map<string, number>();
  for (const item of results) {
    byKind[item.kind] = (byKind[item.kind] ?? 0) + 1;
    callees.set(item.callee, (callees.get(item.callee) ?? 0) + 1);
  }
  const sortedKinds: Record<string, number> = {};
  for (const [kind, count] of Object.entries(byKind).sort(compareCountEntries)) {
    sortedKinds[kind] = count;
  }
  const topCallees = [...callees.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 20)
    .map(([name, count]) => ({ name, count }));
  return { byKind: sortedKinds, topCallees };
}

function compareCountEntries(left: [string, number], right: [string, number]): number {
  return right[1] - left[1] || left[0].localeCompare(right[0]);
}
