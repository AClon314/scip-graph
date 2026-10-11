/**
 * 布局接入（stretch，M1 不接入 TUI/GUI 主流程）。
 *
 * PLAN D3：布局用 ELK layered + orchgraph 的 `layoutGraph` 扩展点注入自定义
 * engine；D2：ELK JSON 只做布局引擎边界，不进 IR。
 *
 * 本模块提供「中立 IR（VisualGraph）→ orchgraph GraphDocument → GraphGeometry
 * → 回填 IR」的适配骨架。当前**未接线**到 TUI/GUI，仅保证可编译、可独立调用，
 * 供 M1 之后的里程碑使用。
 */

import { layoutGraph } from 'orchgraph';
import type { GraphDocument, GraphGeometry } from 'orchgraph';
import type {
  GraphDirection,
  Point,
  VisualGraph,
  VisualGraphEdge,
  VisualGraphNode,
} from '../ir/types';

const DIR_TO_ORCH: Record<GraphDirection, 'DOWN' | 'UP' | 'LEFT' | 'RIGHT'> = {
  down: 'DOWN',
  up: 'UP',
  right: 'RIGHT',
  left: 'LEFT',
};

export interface OrchgraphLayoutOptions {
  direction?: GraphDirection;
  /** orchgraph re-exports ELK spacing knob (2..20). */
  spacing?: number;
}

/** IR → orchgraph GraphDocument（扁平；分组层级 orchgraph 不支持，暂忽略）。 */
export function toOrchgraphDocument<N extends object, E extends object, G>(
  graph: VisualGraph<N, E, G>,
  opts: OrchgraphLayoutOptions = {},
): GraphDocument {
  return {
    id: graph.id,
    direction: DIR_TO_ORCH[opts.direction ?? graph.direction ?? 'down'],
    nodes: graph.nodes.map((n) => ({
      id: n.id,
      label: n.label ?? n.id,
      ...(n.kind ? { kind: n.kind } : {}),
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      source: e.sourceId,
      target: e.targetId,
      ...(e.label != null ? { label: e.label } : {}),
    })),
  };
}

const flatten = (geo: GraphGeometry): Map<string, Point[]> => {
  const m = new Map<string, Point[]>();
  for (const e of geo.edges) {
    const pts: Point[] = e.sections.flat().map((p) => ({ x: round(p.x), y: round(p.y) }));
    m.set(e.id, pts);
  }
  return m;
};

const round = (v: number): number => Math.round(v);

/** 用 orchgraph（ELK）跑布局并回填到一份新的 VisualGraph（不改入参）。 */
export async function layoutWithOrchgraph<N extends object, E extends object, G>(
  graph: VisualGraph<N, E, G>,
  opts: OrchgraphLayoutOptions = {},
): Promise<VisualGraph<N, E, G>> {
  const doc = toOrchgraphDocument(graph, opts);
  const geo = await layoutGraph(doc, {
    direction: doc.direction,
    ...(opts.spacing != null ? { spacing: opts.spacing } : {}),
  });

  const positions = new Map(geo.nodes.map((n) => [n.id, n] as const));
  const routed = flatten(geo);

  const nodes: VisualGraphNode<N>[] = graph.nodes.map((n) => {
    const p = positions.get(n.id);
    return {
      ...n,
      x: p ? round(p.x) : n.x,
      y: p ? round(p.y) : n.y,
      width: p ? round(p.width) : n.width,
      height: p ? round(p.height) : n.height,
    };
  });

  const edges: VisualGraphEdge<E>[] = graph.edges.map((e) => ({
    ...e,
    points: routed.get(e.id) ?? e.points ?? [],
    routing: 'polyline',
  }));

  return { ...graph, nodes, edges };
}
