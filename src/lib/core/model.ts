/**
 * 共享层：框架无关的 UI 视图模型（view-model）。
 *
 * GUI(SvelteKit/Svelte) 与 TUI(opentui) **不共享组件**，共享的是这里：
 *   数据（CallGraph）→ 视图模型（AppVM：tree / legend / scene / status / input）
 *   + 面板栅格布局（ScreenLayout）。两侧各自光栅化。
 *
 * 本文件只做「数据 → 视图」的投影，不含任何终端 / DOM / 框架依赖，
 * 因此可以被 `bun test` 直接单测。
 */

import type { GraphDirection } from '../ir/types';

// ===========================================================================
// 0. 领域模型（从 IR 适配而来；见 ./from-ir.ts）
// ===========================================================================

export type NodeKind = 'class' | 'function' | 'method' | 'module' | string;
export type Dispatch = 'static' | 'virtual' | 'self';

export interface Pt {
  x: number;
  y: number;
}

/** 场景包围盒（top-left + size），供投影器换算到格点/视口。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CallNode {
  id: string;
  label: string;
  kind: NodeKind;
  file: string;
  line: number;
  parentId: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CallEdge {
  id: string;
  from: string;
  to: string;
  label?: string;
  dispatch: Dispatch;
  /** 布局输出的路径点（tail→head，含两端）。 */
  points: Pt[];
}

export interface CallGraph {
  nodes: CallNode[];
  edges: CallEdge[];
  bounds: Rect;
  direction?: GraphDirection;
}

// ===========================================================================
// 1. view model（GUI/TUI 都消费这个）
// ===========================================================================

export interface TreeRow {
  id: string;
  depth: number;
  kind: 'dir' | 'file' | 'symbol';
  label: string;
  symbolId?: string;
  expanded?: boolean;
  hasChildren: boolean;
  badge?: string;
  dimmed?: boolean;
}

export interface LegendItem {
  kind: string;
  label: string;
  color: string;
}

export interface StatusSegment {
  text: string;
  color?: string;
}

export interface GraphNodeVM extends CallNode {
  color: string;
  dimmed: boolean;
  selected: boolean;
}

export interface GraphEdgeVM extends CallEdge {
  color: string;
  dimmed: boolean;
  dashed: boolean;
}

export interface GraphScene {
  nodes: GraphNodeVM[];
  edges: GraphEdgeVM[];
  bounds: Rect;
}

export type Focus = 'tree' | 'graph' | 'input';

export interface AppVM {
  title: StatusSegment[];
  rows: TreeRow[];
  legend: LegendItem[];
  scene: GraphScene;
  status: StatusSegment[];
  input: { value: string; placeholder: string };
  focus: Focus;
}

/** 交互状态：reducer 的输入/输出。 */
export interface AppState {
  graph: CallGraph;
  /** 折叠的 tree 行 id 集合（`dir:` / `file:` 前缀）。 */
  fold: Set<string>;
  selectedId: string | null;
  inputValue: string;
  focus: Focus;
}

// ===========================================================================
// 2. 配色：两侧共用同一组 token（GUI 里再映射成 CSS 变量）
// ===========================================================================

export const KIND_COLOR: Record<string, string> = {
  class: '#7aa2f7',
  function: '#9ece6a',
  method: '#e0af68',
  module: '#bb9af7',
  dir: '#7dcfff',
  file: '#c0caf5',
  dim: '#565f89',
  edge: '#737aa2',
  edgeVirtual: '#bb9af7',
  accent: '#f7768e',
};

export const colorFor = (kind: string): string => KIND_COLOR[kind] ?? KIND_COLOR.file!;

// ===========================================================================
// 3. view model 构建（纯函数）
// ===========================================================================

export function buildAppVM(state: AppState): AppVM {
  const { graph, fold, selectedId } = state;

  const neighbors = new Set<string>();
  if (selectedId) {
    neighbors.add(selectedId);
    for (const e of graph.edges) {
      if (e.from === selectedId) neighbors.add(e.to);
      if (e.to === selectedId) neighbors.add(e.from);
    }
  }

  const scene: GraphScene = {
    bounds: graph.bounds,
    nodes: graph.nodes.map((n): GraphNodeVM => ({
      ...n,
      color: colorFor(n.kind),
      selected: n.id === selectedId,
      dimmed: selectedId !== null && !neighbors.has(n.id),
    })),
    edges: graph.edges.map((e): GraphEdgeVM => {
      const touches = selectedId !== null && (e.from === selectedId || e.to === selectedId);
      return {
        ...e,
        color: e.dispatch === 'virtual' ? KIND_COLOR.edgeVirtual! : KIND_COLOR.edge!,
        dashed: e.dispatch === 'virtual',
        dimmed: selectedId !== null && !touches,
      };
    }),
  };

  return {
    title: [{ text: 'scip-graph', color: KIND_COLOR.accent }, { text: '  ir → vm demo' }],
    rows: buildTree(graph, fold, selectedId),
    legend: (['class', 'function', 'method', 'module'] as const).map((k) => ({
      kind: k,
      label: k,
      color: colorFor(k),
    })),
    scene,
    status: buildStatus(graph, neighbors, selectedId),
    input: { value: state.inputValue, placeholder: 'query: callers <symbol> …' },
    focus: state.focus,
  };
}

/** file tree：由 call graph 节点的 `file` 字段派生；`fold` 集合控制折叠。 */
export function buildTree(graph: CallGraph, fold: Set<string>, selectedId: string | null): TreeRow[] {
  interface Dir {
    name: string;
    path: string;
    dirs: Map<string, Dir>;
    files: Map<string, CallNode[]>;
  }
  const root: Dir = { name: '', path: '', dirs: new Map(), files: new Map() };

  for (const n of graph.nodes) {
    // 分组节点（目录）的 file 以 `/` 结尾或为空——它们不是符号所在文件。
    if (!n.file || n.file.endsWith('/')) continue;
    const parts = n.file.split('/');
    const fileName = parts.pop()!;
    let cur = root;
    for (const seg of parts) {
      const path = cur.path ? `${cur.path}/${seg}` : seg;
      cur.dirs.set(seg, cur.dirs.get(seg) ?? { name: seg, path, dirs: new Map(), files: new Map() });
      cur = cur.dirs.get(seg)!;
    }
    cur.files.set(fileName, [...(cur.files.get(fileName) ?? []), n]);
  }

  const rows: TreeRow[] = [];
  const walk = (dir: Dir, depth: number) => {
    for (const sub of dir.dirs.values()) {
      const id = `dir:${sub.path}`;
      const expanded = !fold.has(id);
      rows.push({ id, depth, kind: 'dir', label: `${sub.name}/`, expanded, hasChildren: true });
      if (expanded) walk(sub, depth + 1);
    }
    for (const [name, symbols] of dir.files) {
      const filePath = dir.path ? `${dir.path}/${name}` : name;
      const id = `file:${filePath}`;
      const expanded = !fold.has(id);
      rows.push({
        id,
        depth,
        kind: 'file',
        label: name,
        expanded,
        hasChildren: symbols.length > 0,
        badge: `${symbols.length}`,
      });
      if (!expanded) continue;
      for (const s of symbols) {
        rows.push({
          id: `sym:${s.id}`,
          depth: depth + 1,
          kind: 'symbol',
          label: s.label,
          symbolId: s.id,
          hasChildren: false,
          dimmed: selectedId !== null && selectedId !== s.id,
        });
      }
    }
  };
  walk(root, 0);
  return rows;
}

function buildStatus(graph: CallGraph, neighbors: Set<string>, selectedId: string | null): StatusSegment[] {
  if (selectedId !== null) {
    const edges = graph.edges.filter((e) => neighbors.has(e.from) && neighbors.has(e.to));
    return [
      { text: `selected ${selectedId}`, color: KIND_COLOR.accent },
      { text: ` · ${Math.max(0, neighbors.size - 1)} neighbors` },
      { text: ` · ${edges.length} edges` },
    ];
  }
  return [
    { text: `${graph.nodes.length} nodes` },
    { text: ` · ${graph.edges.length} edges` },
    { text: ` · ${new Set(graph.nodes.map((n) => n.file).filter(Boolean)).size} files` },
  ];
}

// ===========================================================================
// 4. 面板栅格布局（TUI-first：单位是字符格；GUI 用 flex/ch 映射）
// ===========================================================================

export interface CellRect {
  col: number;
  row: number;
  width: number;
  height: number;
}

export interface ScreenLayout {
  cols: number;
  rows: number;
  header: CellRect;
  tree: CellRect;
  graph: CellRect;
  legend: CellRect;
  status: CellRect;
  input: CellRect;
}

export function layoutScreen(cols: number, rows: number): ScreenLayout {
  const treeW = Math.max(24, Math.min(36, Math.floor(cols * 0.3)));
  const headerH = 1;
  const barH = 2; // status + input
  const bodyRow = headerH;
  const bodyH = Math.max(1, rows - headerH - barH);
  const graphCol = treeW;
  const graphW = Math.max(1, cols - treeW);
  const legendW = 20;
  const legendH = 6;
  return {
    cols,
    rows,
    header: { col: 0, row: 0, width: cols, height: headerH },
    tree: { col: 0, row: bodyRow, width: treeW, height: bodyH },
    graph: { col: graphCol, row: bodyRow, width: graphW, height: bodyH },
    legend: { col: graphCol + 1, row: bodyRow + bodyH - legendH - 1, width: legendW, height: legendH },
    status: { col: 0, row: rows - barH, width: cols, height: 1 },
    input: { col: 0, row: rows - 1, width: cols, height: 1 },
  };
}

/** 场景坐标 → 面板内格点（TUI 用；GUI 用 SVG viewBox，不需要）。 */
export function sceneProjector(scene: GraphScene, rect: CellRect) {
  const pad = 3;
  const w = Math.max(1, rect.width - pad * 2);
  const h = Math.max(1, rect.height - pad * 2);
  const sx = w / Math.max(1, scene.bounds.width);
  const sy = h / Math.max(1, scene.bounds.height);
  return (p: Pt): { col: number; row: number } => ({
    col: Math.round(rect.col + pad + (p.x - scene.bounds.x) * sx),
    row: Math.round(rect.row + pad + (p.y - scene.bounds.y) * sy),
  });
}
