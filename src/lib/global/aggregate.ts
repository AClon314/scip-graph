/**
 * Level aggregation for the global density view.
 *
 * Faithful TypeScript port of `tmp/scip-graph-viewer/view-a/lib/aggregate.js`.
 *
 * Levels:
 *   dir    -> first 3 path segments of node.file  (e.g. src/lib/components)
 *   file   -> full file path
 *   symbol -> each node individually
 *
 * Node weight = group member count (dir/file) or call degree (symbol).
 * Node degree = summed member call activity (dir/file) or the raw call degree
 * (symbol). Node rectangle size = base 60x24 world units, scaled by a bounded
 * sqrt of the degree relative to that level's median (keeps one giant group
 * from becoming a wall while still encoding degree monotonically). Pass
 * `{ sizeByDegree: false }` for uniform base-sized rectangles.
 */

import type { SgGraph, SgNode, SgRange } from '$lib/graph/schema';

export const LEVELS = ['dir', 'file', 'symbol'] as const;
export type Level = (typeof LEVELS)[number];

export const BASE_W = 60;
export const BASE_H = 24;

/** Dispatch precedence used when collapsing several edges into one group pair. */
const DISPATCH_RANK: Record<string, number> = { static: 0, virtual: 1, self: 2 };

/** An aggregated node with its assigned (drawn) rectangle half-extent. */
export type AggNode = {
  id: string;
  label: string;
  level: Level;
  weight: number;
  /** Call degree driving the rectangle size: (in + out) calls at symbol level,
   * summed member call activity at dir/file level. */
  degree: number;
  intraCalls: number;
  svelte: boolean;
  /** Half width / half height of the drawn rectangle, in world units. */
  hw: number;
  hh: number;
  /** Raw graph nodes collapsed into this group. */
  members: SgNode[];
  /** World position, assigned by the layout worker. */
  x?: number;
  y?: number;
  /** Symbol level: representative member name (shown as the canvas label). */
  name?: string;
  /** Symbol level: file / 1-based line of the representative member. */
  file?: string;
  line?: number;
  kind?: string;
  /** Symbol level: definition range, preserved for jump-to-source. */
  range?: SgRange;
};

/** An aggregated directed edge between two group keys. */
export type AggEdge = {
  source: string;
  target: string;
  calls: number;
  count: number;
  dispatch: 'static' | 'virtual' | 'self';
  confidence: number;
};

export type Aggregation = {
  level: Level;
  nodes: AggNode[];
  edges: AggEdge[];
  groups: number;
  selfCalls: number;
  rawNodeCount: number;
  rawEdgeCount: number;
};

/** Options controlling how node rectangles are sized. */
export type AggregateOptions = {
  /** Scale rectangle size by call degree (default true); false = uniform base size. */
  sizeByDegree?: boolean;
};

/** Node-id sets for each level, used to resolve a persisted selection's level. */
export function levelIdSets(graph: SgGraph): Record<Level, Set<string>> {
  const dir = new Set<string>();
  const file = new Set<string>();
  const symbol = new Set<string>();
  for (const node of graph.nodes) {
    dir.add(groupKey(node, 'dir'));
    file.add(groupKey(node, 'file'));
    symbol.add(node.id);
  }
  return { dir, file, symbol };
}

/** Group key for a node at a level. */
export function groupKey(node: SgNode, level: Level): string {
  if (level === 'symbol') return node.id;
  if (level === 'file') return node.file;
  return node.file.split('/').slice(0, 3).join('/');
}

function median(values: number[]): number {
  if (!values.length) return 1;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 1;
}

function scaleFor(weight: number, ref: number): number {
  const raw = Math.sqrt(weight / ref);
  return Math.min(2.2, Math.max(0.75, raw));
}

function shortLabel(id: string, level: Level): string {
  if (level === 'dir') {
    const parts = id.split('/');
    return parts.length > 1 ? parts[parts.length - 1] || id : id;
  }
  if (level === 'file') {
    const parts = id.split('/');
    return parts[parts.length - 1] || id;
  }
  return id;
}

/** Aggregate the frozen graph to one of the three hierarchy levels. */
export function aggregate(
  graph: SgGraph,
  level: Level,
  options: AggregateOptions = {}
): Aggregation {
  const groups = new Map<
    string,
    {
      id: string;
      label: string;
      members: SgNode[];
      weight: number;
      degree: number;
      intraCalls: number;
      svelte: boolean;
    }
  >();

  for (const node of graph.nodes) {
    const key = groupKey(node, level);
    let group = groups.get(key);
    if (!group) {
      group = {
        id: key,
        label: shortLabel(key, level),
        members: [],
        weight: 0,
        degree: 0,
        intraCalls: 0,
        svelte: false,
      };
      groups.set(key, group);
    }
    group.members.push(node);
    group.weight += 1;
    group.degree += Math.max(1, node.weight ?? 1);
    if (node.svelte) group.svelte = true;
  }

  // Symbol level uses the raw call degree rather than the member count (1).
  if (level === 'symbol') {
    for (const group of groups.values()) {
      const node = group.members[0];
      group.weight = Math.max(1, node?.weight ?? 1);
      group.degree = group.weight;
    }
  }

  const sizeByDegree = options.sizeByDegree ?? true;
  const ref = median([...groups.values()].map((g) => g.degree));
  const nodes: AggNode[] = [];
  for (const group of groups.values()) {
    const scale = sizeByDegree ? scaleFor(group.degree, ref) : 1;
    const hw = (BASE_W * scale) / 2;
    const hh = (BASE_H * scale) / 2;
    const node: AggNode = {
      id: group.id,
      label: group.label,
      level,
      weight: group.weight,
      degree: group.degree,
      intraCalls: group.intraCalls,
      svelte: group.svelte,
      hw,
      hh,
      members: group.members,
    };
    if (level === 'symbol') {
      const member = group.members[0];
      if (member) {
        node.name = member.name;
        node.file = member.file;
        node.line = member.line;
        node.kind = member.kind;
        node.range = member.range;
      }
    }
    nodes.push(node);
  }

  const edgeMap = new Map<string, AggEdge>();
  const keyOf = new Map(graph.nodes.map((n) => [n.id, groupKey(n, level)]));
  let selfCalls = 0;
  for (const edge of graph.edges) {
    const source = keyOf.get(edge.from);
    const target = keyOf.get(edge.to);
    if (source === undefined || target === undefined) continue;
    if (source === target) {
      selfCalls += edge.calls || 1;
      const group = groups.get(source);
      if (group) group.intraCalls += edge.calls || 1;
      continue;
    }
    const key = `${source}\u0000${target}`;
    let agg = edgeMap.get(key);
    if (!agg) {
      agg = {
        source,
        target,
        calls: 0,
        count: 0,
        dispatch: edge.dispatch,
        confidence: edge.confidence,
      };
      edgeMap.set(key, agg);
    }
    agg.calls += edge.calls || 1;
    agg.count += 1;
    if ((DISPATCH_RANK[edge.dispatch] ?? 0) > (DISPATCH_RANK[agg.dispatch] ?? 0)) {
      agg.dispatch = edge.dispatch;
    }
    agg.confidence = Math.min(agg.confidence ?? 1, edge.confidence ?? 1);
  }

  for (const node of nodes) node.intraCalls = groups.get(node.id)?.intraCalls ?? 0;

  return {
    level,
    nodes,
    edges: [...edgeMap.values()],
    groups: groups.size,
    selfCalls,
    rawNodeCount: graph.nodes.length,
    rawEdgeCount: graph.edges.length,
  };
}
