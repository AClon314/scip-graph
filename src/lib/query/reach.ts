/**
 * Reachability: BFS over call edges in one or both directions.
 *
 * `depth` 0 means "the root only". The reported `tree` keeps only the first
 * discovery of each node, so cycles never expand indefinitely.
 */

import { UsageError, compareNodes, getNode, type GraphIndex } from './graph';
import type { SgEdge } from '../graph/schema';

export type TraverseDirection = 'callers' | 'callees' | 'both';

const DIRECTIONS: ReadonlySet<string> = new Set(['callers', 'callees', 'both']);

/** One reached node with its BFS distance from the roots. */
export type TraverseNode = { id: string; distance: number };

/** One BFS tree edge (first discovery). */
export type TraverseTreeEdge = { from: string; to: string; edge: SgEdge };

export type TraverseOptions = {
  start?: string[];
  direction?: string;
  depth?: string | number;
};

export type TraverseResult = {
  direction: TraverseDirection;
  depth: number;
  rootIds: string[];
  nodes: TraverseNode[];
  edges: SgEdge[];
  tree: TraverseTreeEdge[];
  maxDepthReached: number;
};

/** BFS from `options.start` along `direction`, out to `depth` hops. */
export function traverse(graph: GraphIndex, options: TraverseOptions = {}): TraverseResult {
  const direction = (options.direction ?? 'callees') as TraverseDirection;
  if (!DIRECTIONS.has(direction)) throw new UsageError(`direction 非法：${direction}`);
  const depth = normalizeDepth(options.depth ?? 1);
  const rootIds = [...new Set(options.start ?? [])].sort();
  if (rootIds.length === 0) throw new UsageError('traverse 需要至少一个起点');
  const distance = new Map<string, number>(rootIds.map((id) => [id, 0]));
  const tree: TraverseTreeEdge[] = [];
  const queue = [...rootIds];
  let maxDepthReached = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const current = queue[head];
    const nextDistance = (distance.get(current) ?? 0) + 1;
    if (nextDistance > depth) continue;
    for (const { id: next, edge } of neighborEdges(graph, current, direction)) {
      if (distance.has(next)) continue;
      distance.set(next, nextDistance);
      queue.push(next);
      tree.push({ from: current, to: next, edge });
      if (nextDistance > maxDepthReached) maxDepthReached = nextDistance;
    }
  }
  const nodes = [...distance.entries()]
    .map(([id, dist]) => ({ id, distance: dist }))
    .sort(
      (left, right) =>
        left.distance - right.distance ||
        compareNodes(getNode(graph, left.id), getNode(graph, right.id)),
    );
  const reached = new Set(distance.keys());
  return {
    direction,
    depth,
    rootIds,
    nodes,
    edges: subgraphEdges(graph, reached),
    tree,
    maxDepthReached,
  };
}

/** Non-negative integer depth (accepts the raw CLI string). */
export function normalizeDepth(value: string | number): number {
  const depth = Number(value);
  if (!Number.isInteger(depth) || depth < 0) {
    throw new UsageError(`--depth 必须是非负整数，收到 ${JSON.stringify(value)}`);
  }
  return depth;
}

/** Neighbour edges of a node in a direction (deduped by neighbour id, sorted). */
export function neighborEdges(
  graph: GraphIndex,
  id: string,
  direction: TraverseDirection,
): { id: string; edge: SgEdge }[] {
  const entries: { id: string; edge: SgEdge }[] = [];
  if (direction === 'callees' || direction === 'both') {
    for (const edge of graph.outEdges.get(id) ?? []) entries.push({ id: edge.to, edge });
  }
  if (direction === 'callers' || direction === 'both') {
    for (const edge of graph.inEdges.get(id) ?? []) entries.push({ id: edge.from, edge });
  }
  const byId = new Map<string, { id: string; edge: SgEdge }>();
  for (const entry of entries) if (!byId.has(entry.id)) byId.set(entry.id, entry);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** All call edges whose both endpoints are in `reached` (sorted). */
export function subgraphEdges(graph: GraphIndex, reached: Set<string>): SgEdge[] {
  const edges: SgEdge[] = [];
  for (const edge of graph.edges) {
    if (reached.has(edge.from) && reached.has(edge.to)) edges.push(edge);
  }
  return edges.sort(compareEdgeTo);
}

function compareEdgeTo(left: SgEdge, right: SgEdge): number {
  return left.to.localeCompare(right.to) || left.from.localeCompare(right.from);
}
