/**
 * IR → 共享 view-model 的适配器。
 *
 * 这是 `src/lib/core/` 消费 `src/lib/ir/` 的唯一入口：把中立 IR
 * （`VisualGraph`，几何必填）投影成 UI 领域模型 `CallGraph`。
 *
 * 领域负载（`node.data` / `edge.data`）按 SCIP 约定读取；缺失时给安全默认值，
 * 因此对非 SCIP 的 IR 也能渲染（只是 file/line 等字段为空）。
 */

import type { EdgeData, GraphEdge, GraphNode, NodeData, Point, VisualGraph } from '../ir/types';
import type { CallEdge, CallGraph, CallNode, Dispatch, Pt, Rect } from './model';

interface ScipNodeDataLike {
  file?: string;
  line?: number;
  kind?: string;
}

interface ScipEdgeDataLike {
  dispatch?: Dispatch;
}

const nodeData = (n: GraphNode<NodeData>): ScipNodeDataLike => (n.data ?? {}) as ScipNodeDataLike;
const edgeData = (e: GraphEdge<EdgeData>): ScipEdgeDataLike => (e.data ?? {}) as ScipEdgeDataLike;

/** 从节点几何 + 边路径求场景包围盒。 */
function boundsOf(nodes: CallNode[], edges: CallEdge[]): Rect {
  if (nodes.length === 0) return { x: 0, y: 0, width: 1, height: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const acc = (x: number, y: number) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  for (const n of nodes) {
    acc(n.x, n.y);
    acc(n.x + n.width, n.y + n.height);
  }
  for (const e of edges) for (const p of e.points) acc(p.x, p.y);
  if (maxX < minX || maxY < minY) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: minX, y: minY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

/**
 * `VisualGraph` → `CallGraph`。
 * 泛型保持开放，使 mock（带私有 `MockNodeData`）也能直接传入。
 */
export function fromIR<N extends object, E extends object, G>(
  graph: VisualGraph<N, E, G>,
): CallGraph {
  const nodes: CallNode[] = graph.nodes.map((n) => {
    const d = nodeData(n as unknown as GraphNode<NodeData>);
    return {
      id: n.id,
      label: n.label ?? d.kind ?? n.id,
      kind: n.kind ?? d.kind ?? 'function',
      file: d.file ?? '',
      line: d.line ?? 1,
      parentId: n.parentId ?? null,
      x: n.x,
      y: n.y,
      width: n.width,
      height: n.height,
    };
  });

  const edges: CallEdge[] = graph.edges.map((e) => {
    const d = edgeData(e as unknown as GraphEdge<EdgeData>);
    const points: Pt[] = (e.points ?? []).map((p: Point) => ({ x: p.x, y: p.y }));
    if (points.length === 0) {
      // 无路由信息时退化成两端中点直线，避免渲染器空指针。
      const s = nodes.find((n) => n.id === e.sourceId);
      const t = nodes.find((n) => n.id === e.targetId);
      if (s && t) {
        points.push(
          { x: s.x + s.width, y: s.y + s.height / 2 },
          { x: t.x, y: t.y + t.height / 2 },
        );
      }
    }
    return {
      id: e.id,
      from: e.sourceId,
      to: e.targetId,
      ...(e.label != null ? { label: e.label } : {}),
      dispatch: d.dispatch ?? 'static',
      points,
    };
  });

  return {
    nodes,
    edges,
    bounds: boundsOf(nodes, edges),
    ...(graph.direction ? { direction: graph.direction } : {}),
  };
}
