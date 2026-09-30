/**
 * Call-site references: turn a node's incident edges into inbound / outbound
 * groups carrying every `edge.sites` entry.
 */

import { describeNode, getNode, type GraphIndex, type NodeSummary } from './graph';
import type { SgEdge, SgEdgeSite } from '../graph/schema';

/** One edge expanded into its call sites. */
export type RefGroup = {
  direction: 'in' | 'out';
  other: NodeSummary;
  dispatch: SgEdge['dispatch'];
  confidence: number;
  calls: number;
  sites: SgEdgeSite[];
};

export type RefsResult = {
  incoming: RefGroup[];
  outgoing: RefGroup[];
  count: number;
};

function refGroup(graph: GraphIndex, edge: SgEdge, other: string, direction: 'in' | 'out'): RefGroup {
  const node = getNode(graph, other);
  return {
    direction,
    other: describeNode(node),
    dispatch: edge.dispatch,
    confidence: edge.confidence,
    calls: edge.calls,
    sites: [...edge.sites].sort(
      (left, right) =>
        left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column,
    ),
  };
}

/** Inbound / outbound call sites of a node, grouped by edge. */
export function refsOf(graph: GraphIndex, id: string): RefsResult {
  const incoming = (graph.inEdges.get(id) ?? []).map((edge) => refGroup(graph, edge, edge.from, 'in'));
  const outgoing = (graph.outEdges.get(id) ?? []).map((edge) => refGroup(graph, edge, edge.to, 'out'));
  const count = [...incoming, ...outgoing].reduce((sum, group) => sum + group.sites.length, 0);
  return { incoming, outgoing, count };
}
