/**
 * Frozen graph schema for scip-graph (`gpen-scip-graph/1`).
 *
 * See the gpen viewer contract:
 * `tmp/scip-graph-viewer/README.md`. Node ids are `"<file>:<1-based line>"`.
 * `range` is reserved for a future "jump to source" action and is not part of
 * the original Phase-0 freeze.
 */

/** Current on-disk schema identifier. */
export const SG_SCHEMA = 'gpen-scip-graph/1';

/** 1-based line + 1-based column. */
export type SgPosition = { line: number; column: number };

/** Definition range (1-based, inclusive start / exclusive end as in SCIP). */
export type SgRange = { start: SgPosition; end: SgPosition };

export type SgNode = {
  /** "<file>:<1-based line>" */
  id: string;
  /** "Function" | "Method" | "Class" | ... */
  kind: string;
  /** Display name (real function name where available). */
  name: string;
  file: string;
  line: number;
  /** Degree (in + out, self loops counted once); drives node size. */
  weight: number;
  svelte: boolean;
  /** Reserved: definition range for future jump-to-source. */
  range?: SgRange;
};

export type SgEdgeSite = { file: string; line: number; column: number };

export type SgEdge = {
  from: string;
  to: string;
  dispatch: 'static' | 'virtual' | 'self';
  confidence: number;
  calls: number;
  sites: SgEdgeSite[];
};

export type SgStats = {
  nodes: number;
  edges: number;
  self_loops: number;
  svelte_nodes: number;
  svelte_edges: number;
  virtual_edges: number;
  call_sites: number;
  kinds: Record<string, number>;
};

export type SgGraph = {
  schema: string;
  source: Record<string, unknown>;
  nodes: SgNode[];
  edges: SgEdge[];
  stats: SgStats;
};

/** Narrow an arbitrary parsed JSON value to an `SgGraph`. */
export function isSgGraph(value: unknown): value is SgGraph {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<SgGraph>;
  return Array.isArray(candidate.nodes) && Array.isArray(candidate.edges);
}
