/**
 * Sub-graph export: Mermaid `flowchart` (inside a Markdown fence) and Graphviz
 * DOT. Both consume a set of node ids plus the edges to draw.
 */

import { compareNodes, getNode, type GraphIndex } from './graph';
import type { SgEdge } from '../graph/schema';

/** Map node ids to safe mermaid ids (`n0`, `n1`, …). */
function mermaidIds(nodes: { id: string }[]): Map<string, string> {
  return new Map(nodes.map((node, index) => [node.id, `n${index}`]));
}

/** Escape a node label for a double-quoted mermaid string. */
function mermaidLabel(node: { name: string; file: string; line: number }): string {
  return `${node.name}<br/>${node.file}:${node.line}`
    .replace(/`/g, "'")
    .replace(/#/g, '#35;')
    .replace(/"/g, '#34;');
}

/** Focused sub-graph → a mermaid `flowchart` inside a Markdown fenced block. */
export function toMermaid(graph: GraphIndex, nodeIds: string[], edges: SgEdge[]): string {
  const nodes = nodeIds.map((id) => getNode(graph, id)).sort(compareNodes);
  const ids = mermaidIds(nodes);
  const lines = ['```mermaid', 'flowchart LR'];
  for (const node of nodes) lines.push(`  ${ids.get(node.id)}["${mermaidLabel(node)}"]`);
  for (const edge of edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) continue;
    lines.push(`  ${ids.get(edge.from)} --> ${ids.get(edge.to)}`);
  }
  lines.push('```');
  return lines.join('\n');
}

function escapeDotLabel(value: string): string {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Focused sub-graph → Graphviz `.dot`. */
export function toDot(graph: GraphIndex, nodeIds: string[], edges: SgEdge[]): string {
  const nodes = nodeIds.map((id) => getNode(graph, id)).sort(compareNodes);
  const lines = ['digraph scip {', '  rankdir=LR;', '  node [shape=box, fontname="monospace"];'];
  for (const node of nodes) {
    const label = `${node.name}\n${node.file}:${node.line}`;
    lines.push(`  "${escapeDotLabel(node.id)}" [label="${escapeDotLabel(label)}"];`);
  }
  for (const edge of edges) {
    if (!graph.nodeById.has(edge.from) || !graph.nodeById.has(edge.to)) continue;
    lines.push(`  "${escapeDotLabel(edge.from)}" -> "${escapeDotLabel(edge.to)}";`);
  }
  lines.push('}');
  return lines.join('\n');
}
