/**
 * gpen-graph/1 — mock data（配合 ./types.ts 看）
 * ==============================================
 *
 * 用途：把中立 IR 的「具体数据长什么样」摊开。四份 mock 覆盖四个面：
 *
 *   1. `mockSemanticGraph`   —— 语义态（未布局）。SCIP call graph，带分组节点。
 *   2. `mockLayeredGraph`    —— ELK layered 已布局态（正交路由 + 端口 + 子节点相对坐标）。
 *   3. `mockSplineGraph`     —— Graphviz 风格 spline 路由。
 *   4. `mockMermaidGraph`    —— mermaid flowchart 风味（形状 + 方向，无几何）。
 *
 * 观察要点：
 *  - 同一份图「语义态 / 布局态」共用 schema，只差几何字段（demo 里用 map 补全）。
 *  - 分组 = 有孩子的节点（`parentId` 指过去）；mermaid `subgraph`、dot `cluster` 同构。
 *  - 渲染器私有状态（折叠、高亮、配色）全部塞 `data.*`，IR 不解释。
 *  - 边的 `x/y/w/h` 是 **label 矩形**；路径看 `points` + `routing`。
 *
 * 想直接看 JSON：`console.log(JSON.stringify(mockLayeredGraph, null, 2))`。
 */

import type {
  EdgeRouting,
  Graph,
  GraphEdge,
  GraphNode,
  Point,
  Rect,
  ScipEdgeData,
  ScipNodeData,
  VisualGraph,
  VisualGraphPort,
} from "./types";

// ===========================================================================
// 领域特化：ScipNodeData/ScipEdgeData + 渲染器私有 view（放 data 里）
// ===========================================================================

/** SCIP 负载 + 各渲染器自己解释的私有状态。 */
type MockNodeData = ScipNodeData & {
  /** 渲染器私有：TUI/GUI 各自解释，IR 不解释。 */
  view?: {
    collapsed?: boolean;
    visible?: boolean;
    pinned?: boolean;
    /** 主题色（GUI/TUI 各自的取色规则）。 */
    color?: string;
  };
};

type MockEdgeData = ScipEdgeData & {
  view?: { highlighted?: boolean };
};

type MockGraphData = {
  tool: string;
  revision?: { git?: string; jj?: string };
};

type MockGraph = Graph<MockNodeData, MockEdgeData, MockGraphData>;
type MockVisualGraph = VisualGraph<MockNodeData, MockEdgeData, MockGraphData>;

// ===========================================================================
// 1. 语义态（未布局）
// ===========================================================================

const ID = {
  dir: "scip-typescript npm gpen-js 0.0.3 src/lib/gestures/",
  boundsFor: "scip-typescript npm gpen-js 0.0.3 src/lib/gestures/draggable.ts/boundsFor().",
  clamp: "scip-typescript npm gpen-js 0.0.3 src/lib/gestures/gestures.ts/clampToBounds().",
  reconcile:
    "scip-typescript npm gpen-js 0.0.3 src/lib/gestures/bounds.ts/reconcileBoundsPosition().",
  draggable: "scip-typescript npm gpen-js 0.0.3 src/lib/gestures/draggable.ts/Draggable#",
  provide:
    "scip-typescript npm gpen-js 0.0.3 src/lib/gestures/types.ts/DraggableBoundsProvider#provide().",
} as const;

const EDGE_ID = {
  draggableToBoundsFor: `${ID.draggable}->${ID.boundsFor}#calls`,
  boundsForToClamp: `${ID.boundsFor}->${ID.clamp}#calls`,
  boundsForToReconcile: `${ID.boundsFor}->${ID.reconcile}#calls`,
  boundsForToProvide: `${ID.boundsFor}->${ID.provide}#calls`,
  reconcileSelf: `${ID.reconcile}->${ID.reconcile}#calls`,
} as const;

export const mockSemanticGraph: MockGraph = {
  schema: "gpen-scip-graph/2",
  id: "gpen-js",
  mode: "directed",
  direction: "right",
  // 易变字段（时间戳）故意不写，保 git diff 干净。
  provenance: {
    producer: "scip-graph/derive@0.1.0",
    revision: { git: "d34173fb17eb5006dbc93117bbcef6a186477a91", jj: "rwlqkmvx" },
  },
  data: { tool: "scip-typescript@0.4.0" },
  nodes: [
    // --- 分组节点：有孩子者即 subgraph / cluster ---
    {
      id: ID.dir,
      kind: "file",
      label: "src/lib/gestures/",
      // 分组自己不开端口；形状/配色由渲染器决定。
      shape: "box",
      data: {
        symbol: ID.dir,
        kind: "file",
        file: "src/lib/gestures/",
        line: 1,
        view: { collapsed: false },
      },
    },

    // --- 图元节点 ---
    {
      id: ID.draggable,
      kind: "class",
      parentId: ID.dir,
      label: "Draggable",
      shape: "roundRect",
      // 端口的**语义**（名称/方向/顺序）；坐标由布局填充。
      ports: [{ name: "bounds", direction: "out", side: "east", index: 0 }],
      data: {
        symbol: ID.draggable,
        kind: "class",
        file: "src/lib/gestures/draggable.ts",
        line: 5,
        range: { startLine: 5, startColumn: 0, endLine: 88, endColumn: 1 },
        weight: 6,
        view: { color: "#7aa2f7" },
      },
    },
    {
      id: ID.boundsFor,
      kind: "function",
      parentId: ID.dir,
      label: "boundsFor",
      ports: [
        { name: "el", direction: "in", side: "west", index: 0 },
        { name: "rect", direction: "out", side: "east", index: 1 },
      ],
      data: {
        symbol: ID.boundsFor,
        kind: "function",
        file: "src/lib/gestures/draggable.ts",
        line: 12,
        range: { startLine: 12, startColumn: 0, endLine: 18, endColumn: 1 },
        weight: 7,
        view: { pinned: true },
      },
    },
    {
      id: ID.clamp,
      kind: "function",
      parentId: ID.dir,
      label: "clampToBounds",
      data: {
        symbol: ID.clamp,
        kind: "function",
        file: "src/lib/gestures/gestures.ts",
        line: 34,
        weight: 5,
      },
    },
    {
      id: ID.reconcile,
      kind: "function",
      parentId: ID.dir,
      label: "reconcileBoundsPosition",
      data: {
        symbol: ID.reconcile,
        kind: "function",
        file: "src/lib/gestures/bounds.ts",
        line: 8,
        weight: 9,
        view: { collapsed: true }, // 渲染器自行解释：折叠不影响布局语义
      },
    },
    {
      id: ID.provide,
      kind: "method",
      parentId: ID.dir,
      label: "provide",
      data: {
        symbol: ID.provide,
        kind: "method",
        file: "src/lib/gestures/types.ts",
        line: 21,
        weight: 3,
      },
    },
  ],
  edges: [
    {
      id: EDGE_ID.draggableToBoundsFor,
      sourceId: ID.draggable,
      targetId: ID.boundsFor,
      kind: "calls",
      // 连到端口的边：ELK/graphviz 需要，mermaid/d3 忽略。
      sourcePort: "bounds",
      label: "drag",
      data: {
        dispatch: "static",
        confidence: 0.9,
        calls: 2,
        sites: [{ file: "src/lib/gestures/draggable.ts", line: 41 }],
      },
    },
    {
      id: EDGE_ID.boundsForToClamp,
      sourceId: ID.boundsFor,
      targetId: ID.clamp,
      sourcePort: "rect",
      kind: "calls",
      data: {
        dispatch: "static",
        confidence: 0.95,
        calls: 3,
        sites: [
          { file: "src/lib/gestures/draggable.ts", line: 14 },
          { file: "src/lib/gestures/draggable.ts", line: 16 },
        ],
      },
    },
    {
      id: EDGE_ID.boundsForToReconcile,
      sourceId: ID.boundsFor,
      targetId: ID.reconcile,
      kind: "calls",
      data: { dispatch: "static", confidence: 0.92, calls: 1 },
    },
    {
      id: EDGE_ID.boundsForToProvide,
      sourceId: ID.boundsFor,
      targetId: ID.provide,
      kind: "calls",
      // 虚分派：callee 是 interface/abstract 成员。
      data: { dispatch: "virtual", confidence: 0.85, calls: 1 },
    },
    {
      id: EDGE_ID.reconcileSelf,
      sourceId: ID.reconcile,
      targetId: ID.reconcile,
      kind: "calls",
      data: { dispatch: "self", confidence: 1, calls: 2 },
    },
  ],
};

// ===========================================================================
// 2. 布局态：ELK layered 输出（正交路由 + 端口坐标 + 子节点相对坐标）
// ===========================================================================
//
// 同一份 schema、同一份语义，只补几何：
//  - 顶层/分组节点坐标是图空间；子节点坐标相对父节点内容区（ELK 约定）。
//  - 边的 points 坐标在两端点 LCA 容器内（此处都在分组 dir 内）。
//  - 边自身无包围盒，`x/y/w/h` 是 label 矩形。

/** 节点几何（分组为绝对坐标；子节点为其内容区内相对坐标）。 */
const nodeGeometry: Record<string, Rect> = {
  [ID.dir]: { x: 0, y: 0, width: 860, height: 220 },
  [ID.draggable]: { x: 16, y: 96, width: 128, height: 44 },
  [ID.boundsFor]: { x: 208, y: 76, width: 140, height: 44 },
  [ID.provide]: { x: 412, y: 20, width: 128, height: 40 },
  [ID.clamp]: { x: 412, y: 96, width: 156, height: 44 },
  [ID.reconcile]: { x: 632, y: 96, width: 208, height: 44 },
};

/** 端口几何（ELK 输出；key = `${nodeId}#${portName}`）。 */
const portGeometry: Record<string, Rect> = {
  [`${ID.draggable}#bounds`]: { x: 124, y: 12, width: 8, height: 8 },
  [`${ID.boundsFor}#el`]: { x: -4, y: 12, width: 8, height: 8 },
  [`${ID.boundsFor}#rect`]: { x: 136, y: 12, width: 8, height: 8 },
};

/** 边路由与 label 矩形（tail→head，含两端端点）。 */
const edgeGeometry: Record<string, { points: Point[]; routing: EdgeRouting; label?: Rect }> = {
  [EDGE_ID.draggableToBoundsFor]: {
    routing: "orthogonal",
    points: [
      { x: 144, y: 108 },
      { x: 176, y: 108 },
      { x: 176, y: 88 },
      { x: 204, y: 88 },
    ],
    // label 矩形（top-left + size）；引擎放置的 x/y + 渲染器测得的 w/h。
    label: { x: 152, y: 114, width: 40, height: 14 },
  },
  [EDGE_ID.boundsForToClamp]: {
    routing: "orthogonal",
    points: [
      { x: 348, y: 88 },
      { x: 380, y: 88 },
      { x: 380, y: 118 },
      { x: 408, y: 118 },
    ],
  },
  [EDGE_ID.boundsForToReconcile]: {
    routing: "orthogonal",
    points: [
      { x: 348, y: 88 },
      { x: 366, y: 88 },
      { x: 366, y: 168 },
      { x: 628, y: 168 },
      { x: 628, y: 118 },
    ],
  },
  [EDGE_ID.boundsForToProvide]: {
    routing: "orthogonal",
    points: [
      { x: 348, y: 88 },
      { x: 380, y: 88 },
      { x: 380, y: 40 },
      { x: 408, y: 40 },
    ],
  },
  // 自环：绕节点上方一圈。
  [EDGE_ID.reconcileSelf]: {
    routing: "orthogonal",
    points: [
      { x: 632, y: 108 },
      { x: 596, y: 108 },
      { x: 596, y: 60 },
      { x: 756, y: 60 },
      { x: 756, y: 108 },
      { x: 840, y: 108 },
    ],
  },
};

const resolvePort = (nodeId: string, port: { name: string }): VisualGraphPort => {
  const g = portGeometry[`${nodeId}#${port.name}`] ?? { x: 0, y: 0, width: 0, height: 0 };
  return { ...port, ...g };
};

export const mockLayeredGraph: MockVisualGraph = {
  ...mockSemanticGraph,
  direction: "right",
  nodes: mockSemanticGraph.nodes.map((n): MockVisualGraph["nodes"][number] => {
    // 先摘掉 ports，再回填带几何的版本（否则条件 spread 会保留 GraphPort 类型）。
    const { ports, ...rest } = n;
    return {
      ...rest,
      ...(nodeGeometry[n.id] ?? { x: 0, y: 0, width: 120, height: 40 }),
      ...(ports && { ports: ports.map((p) => resolvePort(n.id, p)) }),
    };
  }),
  edges: mockSemanticGraph.edges.map((e): MockVisualGraph["edges"][number] => {
    const g = edgeGeometry[e.id];
    return {
      ...e,
      x: g?.label?.x ?? 0,
      y: g?.label?.y ?? 0,
      width: g?.label?.width ?? 0,
      height: g?.label?.height ?? 0,
      ...(g && { points: g.points, routing: g.routing }),
    };
  }),
};

// ===========================================================================
// 3. Graphviz 风格：spline 路由（3n+1 个控制点，tail→head）
// ===========================================================================

export const mockSplineGraph: VisualGraph = {
  schema: "gpen-graph/1",
  id: "spline-demo",
  mode: "directed",
  direction: "right",
  provenance: { producer: "graphviz@9 via @hpcc-js/wasm-graphviz" },
  nodes: [
    {
      id: "parse",
      label: "parse",
      kind: "function",
      shape: "ellipse",
      x: 40,
      y: 60,
      width: 90,
      height: 40,
    },
    {
      id: "optimize",
      label: "optimize",
      kind: "function",
      shape: "ellipse",
      x: 240,
      y: 40,
      width: 100,
      height: 40,
    },
    {
      id: "emit",
      label: "emit",
      kind: "function",
      shape: "ellipse",
      x: 440,
      y: 60,
      width: 80,
      height: 40,
    },
  ],
  edges: [
    {
      id: "parse->optimize#calls",
      sourceId: "parse",
      targetId: "optimize",
      kind: "calls",
      label: "ir",
      // label 矩形（write 回填）。
      x: 150,
      y: 22,
      width: 18,
      height: 14,
      routing: "splines",
      // 3n+1 = 4 点（n=1 段三次贝塞尔）：P0, C1, C2, P3。
      points: [
        { x: 130, y: 74 },
        { x: 168, y: 60 },
        { x: 200, y: 74 },
        { x: 240, y: 60 },
      ],
    },
    {
      id: "optimize->emit#calls",
      sourceId: "optimize",
      targetId: "emit",
      kind: "calls",
      // 无 label 的边：label 矩形全 0（但 VisualGraphEdge 要求字段存在）。
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      routing: "splines",
      points: [
        { x: 340, y: 60 },
        { x: 372, y: 74 },
        { x: 404, y: 60 },
        { x: 440, y: 72 },
      ],
    },
  ],
};

// ===========================================================================
// 4. mermaid flowchart 风味（形状 + 方向，无几何；subgraph 用 parentId）
// ===========================================================================

export const mockMermaidGraph: Graph = {
  schema: "gpen-graph/1",
  id: "retry-flow",
  mode: "directed",
  direction: "down",
  provenance: { producer: "mermaid@11" },
  nodes: [
    { id: "retry", label: "retry", kind: "group", shape: "box" },
    { id: "start", label: "Start", kind: "terminal", shape: "stadium", parentId: "retry" },
    { id: "check", label: "cache hit?", kind: "decision", shape: "diamond", parentId: "retry" },
    { id: "store", label: "Cache", kind: "storage", shape: "cylinder" },
    { id: "ok", label: "Return", kind: "terminal", shape: "doubleCircle" },
    { id: "miss", label: "Fetch", kind: "action", shape: "rectangle" },
  ],
  edges: [
    {
      id: "start->check#flow",
      sourceId: "start",
      targetId: "check",
      kind: "flow",
      // mermaid 的 link 语法（`-->`/`-.->`/`==>`）落在 style 里，不进 IR 语义。
      style: { stroke: "solid", arrowhead: "normal" },
    },
    {
      id: "check->store#flow",
      sourceId: "check",
      targetId: "store",
      kind: "flow",
      label: "yes",
      style: { stroke: "solid" },
    },
    {
      id: "check->miss#flow",
      sourceId: "check",
      targetId: "miss",
      kind: "flow",
      label: "no",
      style: { stroke: "dashed" },
    },
    {
      id: "store->ok#flow",
      sourceId: "store",
      targetId: "ok",
      kind: "flow",
      style: { stroke: "solid" },
    },
    {
      id: "miss->check#flow",
      sourceId: "miss",
      targetId: "check",
      kind: "flow",
      // 回边：mermaid 允许多条同向/反向边，用 id 区分（平行边）。
      style: { stroke: "solid", arrowhead: "normal" },
    },
  ],
};

// ===========================================================================
// 附：规范化 JSON 示例（排序稳定 → 可 git diff）
// ===========================================================================

/** 直接打印看效果。真实实现里 key 顺序走白名单，坐标固定 3 位小数。 */
export const mockLayeredGraphJson = JSON.stringify(mockLayeredGraph, null, 2);

/**
 * 预期 diff 语义（用于对照）：
 *  - 内容变更：nodes/edges 增删、label、kind、data.calls/confidence…
 *  - 重布局  ：node 的 x/y/width/height、edge 的 points/routing/label 矩形。
 *  见 types.ts 的 `LAYOUT_KEYS`。
 */
export const DEMO_EXPECTED_DIFF = {
  content: [
    "node.kind",
    "node.label",
    "edge.data.calls",
    "edge.data.confidence",
    "edge.sourcePort",
  ],
  layout: ["node.x", "node.y", "edge.points", "edge.routing", "edge.x", "edge.y"],
} as const;

// 类型自检：确保 mock 能被当作各自的态使用。
const _nodeCheck: GraphNode<MockNodeData> = mockSemanticGraph.nodes[1]!;
const _edgeCheck: GraphEdge<MockEdgeData> = mockSemanticGraph.edges[0]!;
void _nodeCheck;
void _edgeCheck;

console.debug(mockLayeredGraphJson);
