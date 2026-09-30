/**
 * Graph loading / indexing for the `scip-graph` query CLI.
 *
 * Wraps the frozen `gpen-scip-graph/1` shape (`SgGraph` from `$lib/graph/schema`)
 * with adjacency maps and a name index so the selector / reach / refs modules
 * can work on stable keys.
 *
 * Structured errors (`SelectorError` / `UsageError`) are defined here because
 * they cross module boundaries and drive the CLI exit codes.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { SgEdge, SgGraph, SgNode } from '../graph/schema';

/** Default graph path, relative to the current working directory. */
export const DEFAULT_GRAPH_PATH = 'static/graph.json';

/** CLI exit codes: 0 success, 1 selector error, 2 usage error, 3 missing dependency. */
export const EXIT = { OK: 0, SELECTOR: 1, USAGE: 2, MISSING: 3 } as const;

/** One of the `EXIT` values. */
export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** Compact node projection shared by selector candidates and JSON output. */
export type NodeSummary = {
  id: string;
  name: string;
  file: string;
  line: number;
  kind: string;
};

/** Selector resolution failure; `code` is `invalid` | `not-found` | `ambiguous`. */
export class SelectorError extends Error {
  readonly code: 'invalid' | 'not-found' | 'ambiguous';
  readonly selector: string;
  readonly candidates: NodeSummary[];

  constructor(
    code: 'invalid' | 'not-found' | 'ambiguous',
    selector: string,
    candidates: NodeSummary[],
    message: string,
  ) {
    super(message);
    this.name = 'SelectorError';
    this.code = code;
    this.selector = selector;
    this.candidates = candidates;
  }
}

/** Usage error (unknown subcommand / option, missing argument, conflicting flags). */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Indexed graph: the frozen `SgGraph` plus adjacency / name lookups. */
export type GraphIndex = {
  schema: string | null;
  path: string | null;
  nodes: SgNode[];
  nodeById: Map<string, SgNode>;
  nameIndex: Map<string, string[]>;
  edges: SgEdge[];
  outEdges: Map<string, SgEdge[]>;
  inEdges: Map<string, SgEdge[]>;
  files: string[];
};

/** Resolve the graph path: explicit `--graph` wins, else `static/graph.json` under cwd. */
export function resolveGraphPath(path?: string | null): string {
  if (path) return resolve(path);
  return resolve(DEFAULT_GRAPH_PATH);
}

/** Read the graph from disk and index it. Throws `UsageError` when it is missing. */
export function loadGraph(path?: string | null): GraphIndex {
  const graphPath = resolveGraphPath(path);
  if (!existsSync(graphPath)) {
    throw new UsageError(
      `SCIP 图不存在：${graphPath}（先跑 bun run derive -- --scip <index.json> --out static/graph.json）`,
    );
  }
  const data = JSON.parse(readFileSync(graphPath, 'utf8')) as SgGraph;
  return buildGraph(data, graphPath);
}

/**
 * Build the index from an already-parsed graph (pure function). Out / in
 * adjacency lists are sorted by the neighbour id so BFS is deterministic.
 */
export function buildGraph(data: SgGraph, graphPath: string | null = null): GraphIndex {
  const nodes = data.nodes;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const nameIndex = new Map<string, string[]>();
  for (const node of nodes) {
    const bucket = nameIndex.get(node.name) ?? [];
    bucket.push(node.id);
    nameIndex.set(node.name, bucket);
  }
  const outEdges = new Map<string, SgEdge[]>();
  const inEdges = new Map<string, SgEdge[]>();
  for (const edge of data.edges) {
    pushEdge(outEdges, edge.from, edge);
    pushEdge(inEdges, edge.to, edge);
  }
  for (const list of outEdges.values()) list.sort(compareEdgeTo);
  for (const list of inEdges.values()) list.sort(compareEdgeFrom);
  return {
    schema: data.schema ?? null,
    path: graphPath,
    nodes,
    nodeById,
    nameIndex,
    edges: data.edges,
    outEdges,
    inEdges,
    files: [...new Set(nodes.map((node) => node.file))].sort(),
  };
}

/** Look up a node id that must exist in the index. */
export function getNode(graph: GraphIndex, id: string): SgNode {
  const node = graph.nodeById.get(id);
  if (!node) throw new Error(`node id not present in graph: ${id}`);
  return node;
}

function pushEdge(map: Map<string, SgEdge[]>, key: string, edge: SgEdge): void {
  const list = map.get(key) ?? [];
  list.push(edge);
  map.set(key, list);
}

function compareEdgeTo(left: SgEdge, right: SgEdge): number {
  return compareNodeIds(left.to, left.from, right.to, right.from);
}

function compareEdgeFrom(left: SgEdge, right: SgEdge): number {
  return compareNodeIds(left.from, left.to, right.from, right.to);
}

function compareNodeIds(a1: string, a2: string, b1: string, b2: string): number {
  return a1.localeCompare(b1) || a2.localeCompare(b2);
}

/** Stable node ordering key: file → line → id. */
export function compareNodes(left: SgNode, right: SgNode): number {
  return (
    left.file.localeCompare(right.file) || left.line - right.line || left.id.localeCompare(right.id)
  );
}

/** Node projection used by selector candidates / JSON output. */
export function describeNode(node: SgNode): NodeSummary {
  return {
    id: node.id,
    name: node.name,
    file: node.file,
    line: node.line,
    kind: node.kind,
  };
}
