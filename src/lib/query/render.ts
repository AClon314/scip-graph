/**
 * Human-readable renderers (default CLI output when `--json` is absent).
 * JSON contracts live in `envelope.ts`; these are for people.
 */

import { DEFAULT_INDEX_PATH, type BoundaryData } from './boundaries';
import { getNode, type GraphIndex } from './graph';
import type { RefsResult, RefGroup } from './refs';
import type { TraverseResult } from './reach';

const DIRECTION_LABELS: Record<string, string> = {
  callers: 'callers 反向可达',
  callees: 'callees 正向可达',
  both: 'impact 双向可达',
};

export type RenderTreeOptions = { rootIds?: string[]; maxChildren?: number };

/** Reachability indented tree plus a summary line. */
export function renderTree(
  graph: GraphIndex,
  result: TraverseResult,
  options: RenderTreeOptions = {},
): string {
  const roots = options.rootIds ?? result.rootIds;
  const childrenOf = buildChildrenMap(result.tree);
  const lines = [
    `目标  ${rootIdsLabel(graph, roots)}`,
    `${DIRECTION_LABELS[result.direction] ?? result.direction}（深度 ${result.depth}）：`,
  ];
  roots.forEach((root, index) => {
    pushSubtree(
      graph,
      result,
      childrenOf,
      root,
      null,
      '',
      index === roots.length - 1,
      lines,
      options,
    );
  });
  lines.push(renderSummary(graph, result));
  return lines.join('\n');
}

function rootIdsLabel(graph: GraphIndex, roots: string[]): string {
  if (roots.length === 1) {
    const node = getNode(graph, roots[0]);
    return `${node.name}  ${node.file}:${node.line}`;
  }
  return `${roots.length} 个节点（${roots
    .slice(0, 3)
    .map((id) => getNode(graph, id).name)
    .join(', ')} …）`;
}

function buildChildrenMap(tree: TraverseResult['tree']): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const edge of tree) {
    const list = children.get(edge.from) ?? [];
    list.push(edge.to);
    children.set(edge.from, list);
  }
  for (const list of children.values()) list.sort();
  return children;
}

function pushSubtree(
  graph: GraphIndex,
  result: TraverseResult,
  childrenOf: Map<string, string[]>,
  id: string,
  parentId: string | null,
  prefix: string,
  isLast: boolean,
  lines: string[],
  options: RenderTreeOptions,
): void {
  const maxChildren = Number.isInteger(options.maxChildren) ? (options.maxChildren as number) : 20;
  lines.push(`${prefix}${isLast ? '└─ ' : '├─ '}${nodeLine(graph, result, id, parentId)}`);
  const children = (childrenOf.get(id) ?? []).slice(0, maxChildren);
  const childPrefix = prefix + (isLast ? '   ' : '│  ');
  children.forEach((child, index) => {
    pushSubtree(
      graph,
      result,
      childrenOf,
      child,
      id,
      childPrefix,
      index === children.length - 1,
      lines,
      options,
    );
  });
}

function nodeLine(
  graph: GraphIndex,
  result: TraverseResult,
  id: string,
  parentId: string | null,
): string {
  const node = getNode(graph, id);
  const base = `${node.name}  ${node.file}:${node.line}`;
  if (parentId === null) return base;
  const parent = getNode(graph, parentId);
  const arrow =
    result.direction === 'callees'
      ? '←'
      : result.direction === 'callers'
        ? '→'
        : arrowByEdge(graph, parentId, id);
  return `${base}  ${arrow} ${parent.name}  ${parent.file}:${parent.line}`;
}

function arrowByEdge(graph: GraphIndex, parentId: string, childId: string): string {
  return hasEdge(graph, parentId, childId) ? '←' : '→';
}

function hasEdge(graph: GraphIndex, from: string, to: string): boolean {
  return (graph.outEdges.get(from) ?? []).some((edge) => edge.to === to);
}

function renderSummary(graph: GraphIndex, result: TraverseResult): string {
  const files = new Set<string>();
  for (const item of result.nodes) files.add(getNode(graph, item.id).file);
  return `汇总：节点 ${result.nodes.length} 个 / 文件 ${files.size} 个 / 边 ${result.edges.length} 条 / 最大深度 ${result.maxDepthReached}`;
}

/** refs human view (grouped by inbound / outbound). */
export function renderRefs(graph: GraphIndex, nodeId: string, refs: RefsResult): string {
  const node = getNode(graph, nodeId);
  const lines = [
    `refs  ${node.name}  ${node.file}:${node.line}  （${refs.count} 处调用点）`,
    `入站（${refs.incoming.length} 条边）：`,
    ...refs.incoming.flatMap((group) => refGroupLines(group, '←')),
    `出站（${refs.outgoing.length} 条边）：`,
    ...refs.outgoing.flatMap((group) => refGroupLines(group, '→')),
  ];
  return lines.join('\n');
}

function refGroupLines(group: RefGroup, arrow: string): string[] {
  const other = group.other;
  const head = `  ${arrow} ${other.name}  ${other.file}:${other.line}  ${group.dispatch} ×${group.calls}`;
  return [head, ...group.sites.map((site) => `      ${site.file}:${site.line}:${site.column}`)];
}

export type RenderBoundariesOptions = { maxItems?: number; indexPath?: string };

/** Boundaries human view (kind / top-callee summary plus samples). */
export function renderBoundaries(data: BoundaryData, options: RenderBoundariesOptions = {}): string {
  const maxItems = Number.isInteger(options.maxItems) ? (options.maxItems as number) : 20;
  const lines = [
    `未解析边界：${data.count} 处（fork 索引 ${options.indexPath ?? DEFAULT_INDEX_PATH}）`,
  ];
  const kinds = Object.entries(data.breakdown?.byKind ?? {});
  if (kinds.length > 0)
    lines.push(`按类别：${kinds.map(([kind, count]) => `${kind}×${count}`).join(', ')}`);
  const tops = data.breakdown?.topCallees ?? [];
  if (tops.length > 0)
    lines.push(
      `Top callee：${tops
        .slice(0, 12)
        .map((item) => `${item.name}×${item.count}`)
        .join(', ')}`,
    );
  const shown = data.results.slice(0, maxItems);
  if (shown.length > 0) lines.push(`样例（前 ${shown.length} / 共 ${data.count}）：`);
  for (const item of shown) {
    lines.push(`  [${item.kind}] ${item.file}:${item.line}  ${item.callee}  ${item.symbol}`);
  }
  if (data.results.length > shown.length) {
    lines.push(`  … 其余 ${data.results.length - shown.length} 条省略（--limit 调整）`);
  }
  return lines.join('\n');
}
