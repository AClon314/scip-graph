/**
 * Stable `--json` envelopes. The key order is part of the contract:
 * reachability: query → selector → depth → count → results → edges;
 * refs: query → selector → count → results;
 * boundaries: query → selector → limit → count → results → breakdown → reason.
 */

import { buildBreakdown, type BoundaryData } from './boundaries';
import { describeNode, getNode, type GraphIndex, type NodeSummary } from './graph';
import type { RefsResult } from './refs';
import type { TraverseResult } from './reach';
import type { SgEdge } from '../graph/schema';

export type ReachEnvelope = {
  query: string;
  selector: string;
  depth: number;
  count: number;
  results: (NodeSummary & { distance: number })[];
  edges: { from: string; to: string; dispatch: SgEdge['dispatch']; calls: number }[];
};

export type RefsEnvelope = {
  query: 'refs';
  selector: string;
  count: number;
  results: { incoming: RefsResult['incoming']; outgoing: RefsResult['outgoing'] };
};

export type BoundaryEnvelope = {
  query: 'boundaries';
  selector: string | null;
  limit: number | null;
  count: number;
  results: BoundaryData['results'];
  breakdown: NonNullable<BoundaryData['breakdown']>;
  reason: string | null;
};

/** Reachability envelope (deterministic key order). */
export function buildReachEnvelope(
  query: string,
  selector: string,
  result: TraverseResult,
  graph: GraphIndex,
): ReachEnvelope {
  return {
    query,
    selector,
    depth: result.depth,
    count: result.nodes.length,
    results: result.nodes.map((item) => {
      const node = getNode(graph, item.id);
      return { ...describeNode(node), distance: item.distance };
    }),
    edges: result.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      dispatch: edge.dispatch,
      calls: edge.calls,
    })),
  };
}

/** refs envelope (`results` holds the incoming / outgoing groups). */
export function buildRefsEnvelope(selector: string, refs: RefsResult): RefsEnvelope {
  return {
    query: 'refs',
    selector,
    count: refs.count,
    results: { incoming: refs.incoming, outgoing: refs.outgoing },
  };
}

/** boundaries envelope. */
export function buildBoundaryEnvelope(
  selector: string | null,
  data: BoundaryData,
  limit: number | null | undefined,
): BoundaryEnvelope {
  return {
    query: 'boundaries',
    selector,
    limit: limit ?? null,
    count: data.count,
    results: data.results,
    breakdown: data.breakdown ?? buildBreakdown(data.results),
    reason: data.reason ?? null,
  };
}
