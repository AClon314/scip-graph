/**
 * gpen-graph/1 — 中立图 IR（semantic + positioned）
 * =================================================
 *
 * 目标：一份**与渲染器、布局引擎、图源格式都无关**的 JSON 图模型，作为
 * scip-graph / TUI / GUI / mermaid / graphviz / elk 之间的唯一交换契约。
 *
 * 设计原则
 * --------
 * 1. **纯 JSON**：全部字段可 `JSON.stringify`，无 class、无 Map/Set、无 Date、
 *    无函数。可 structuredClone 跨 worker，可写盘，可 `git diff`。
 * 2. **语义与几何同 schema、两态**：未布局 = `Graph`，已布局 = `VisualGraph`
 *    （几何字段从可选变必填）。不引入第二套坐标系 schema。
 * 3. **引擎只出现在适配器里**：ELK 的 `layoutOptions`、Graphviz 的 `rankdir`、
 *    mermaid 的 link 语法都不进 IR；它们只在 `toELK`/`fromELK` 等转换时出现。
 * 4. **层次用 `parentId` 表达**：subgraph / cluster / compound 一律是「有孩子的
 *    节点」。这与 mermaid `subgraph`、graphviz `cluster`、ELK `children`、
 *    xyflow `parentId` 的映射都是单射。
 * 5. **边永远是扁平数组**：不采用 ELK「边可以挂在任意节点下」的自由度。扁平 +
 *    排序稳定 ⇒ diff 友好，且消除「这条边归哪个 container」的歧义。
 * 6. **坐标是 top-left**：节点 `(x,y)` 为左上角；子节点坐标相对父节点内容区
 *    （ELK/xyflow 约定）。边的 `x/y/w/h` 恒为 **label 矩形**（见下）。
 *
 * 明确不做
 * --------
 * - **超边（hyperedge）**：一条边恰有一个 source、一个 target。ELK 的 extended
 *   edge 支持多源多汇，call graph / mermaid / graphviz 的主流用法都不需要；
 *   真需要时引入分支节点。原因：多段 `sections` + `junctionPoints` 会污染模型，
 *   且每种引擎表达能力不同。
 * - **引擎参数入模型**：不给 `canvasScale`、`rankdir`、`elk.spacing.*` 留字段。
 * - **HTML label / 富文本**：`label` 是纯字符串；富文本走 `data`。
 * - **折叠态、选中态等视口状态**：只在 `GraphNode.collapsed` 这类明确的 UI hint
 *   上出现，不参与布局语义（布局层遇折叠应自行忽略子树）。
 *
 * 与各方言的能力/映射速查
 * ----------------------
 * | IR 字段            | ELK (layered...)                    | Mermaid              | Graphviz           | dagre / d3-force      |
 * | ------------------ | ----------------------------------- | -------------------- | ------------------ | --------------------- |
 * | node.id            | `ElkNode.id`                        | 节点 id              | node name          | id                    |
 * | node.label         | `labels[].text`                     | `A[...]`             | `label`            | id / label            |
 * | node.parentId      | `children` 嵌套                     | `subgraph`           | `subgraph cluster_`| (d3 无)               |
 * | node.shape         | ✗（唯一 CSS/layoutOption 近似）     | `[...]` 形状语法     | `shape=`           | ✗                     |
 * | node.ports         | `ports`（一等）                     | ✗                    | `a:port:compass`   | ✗                     |
 * | direction          | `elk.direction`                     | `flowchart TB/LR...` | `rankdir`          | `rankdir`             |
 * | edge.id            | `ElkEdge.id`（必填）                | ✗（合成）            | ✗（合成）          | ✗（合成）             |
 * | edge.source/target | `sources[]` / `targets[]`           | 链式 `A --> B`       | `A -> B`           | source/target         |
 * | edge.label         | `labels[].text`                     | `-->|text|`          | `label=`           | `label`               |
 * | edge.points        | `sections[0]` 摊平                  | ✗                    | spline 控制点      | `points[]`            |
 * | edge.routing       | `edgeRouting`（ORTHOGONAL/SPLINES） | ✗                    | 恒 splines         | 恒 polyline           |
 * | edge.x/y/w/h       | label 对象 x/y + 测得 w/h           | label 尺寸（估算）   | label xl/yl        | `edge.x/y` = label 中心 |
 */

// ===========================================================================
// 0. JSON 基础类型
// ===========================================================================

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

/**
 * 节点/边/图的领域负载；中性 IR 只承诺「可 JSON 序列化」。
 *
 * 这里故意放宽到 `object`（而非 `JsonObject`）：TS 的 interface **不会**自动获得
 * 隐式索引签名，若约束成 `JsonObject`，形如 `interface ScipNodeData { symbol: string }`
 * 的特化就无法赋给裸 `Graph`。想要强 JSON 类型时显式用 `JsonObject`。
 */
export type NodeData = object;
export type EdgeData = object;
export type GraphData = JsonValue;

/** 视觉样式：引擎/渲染器无关的自由键值（颜色、线宽、dash…）。 */
export type Style = Record<string, string | number | boolean>;

// ===========================================================================
// 1. 枚举与联合
// ===========================================================================

/**
 * 有向性。图级给默认值，边级可覆盖（对应混合图，ELK 仅在 `edgeDirectedness`
 * 里部分支持，dagre 完全不支持）。
 */
export type GraphMode = 'directed' | 'undirected' | 'bidirectional';

/**
 * 布局主轴，统一四方向：
 * - Mermaid: TB/TD→down, BT→up, LR→right, RL→left
 * - Graphviz/dagre: TB/BT/LR/RL → rankdir
 * - ELK: `elk.direction` DOWN/UP/RIGHT/LEFT
 */
export type GraphDirection = 'down' | 'up' | 'right' | 'left';

/**
 * 边路径的解释方式（`points` 的语义）：
 * - `polyline`   —— 依次连线的折线（dagre、ELK 正交输出的通用降级形式）
 * - `orthogonal` —— 轴对齐折线（ELK layered `edgeRouting: ORTHOGONAL`）
 * - `splines`    —— 三次贝塞尔控制点，Graphviz 约定：3n+1 个点、tail→head 串联
 * 缺省（无 `routing`）＝两点直线；物理布局（d3-force/ForceAtlas2）通常不产出 `points`。
 */
export type EdgeRouting = 'polyline' | 'orthogonal' | 'splines';

/** 端口的数据流向（对布局是**建议**，如 ELK 映射到 West/East side）。 */
export type PortDirection = 'in' | 'out' | 'inout';

/** 端口贴边方位；覆盖 Graphviz 的 8 向 compass，ELK 只取四正方向。 */
export type PortSide = 'north' | 'northEast' | 'east' | 'southEast' | 'south' | 'southWest' | 'west' | 'northWest';

/**
 * 节点形状的中性名。取 mermaid / graphviz 的交集 + 常用项；
 * 用 `(string & {})` 保留扩展位（未知形状由渲染器自行降级为矩形）。
 */
export type KnownNodeShape =
  | 'rectangle'
  | 'roundRect'
  | 'stadium'
  | 'subroutine'
  | 'cylinder'
  | 'circle'
  | 'doubleCircle'
  | 'ellipse'
  | 'diamond'
  | 'hexagon'
  | 'parallelogram'
  | 'trapezoid'
  | 'asymmetric'
  | 'text'
  | 'image'
  | 'note'
  | 'box'
  | 'record'
  | 'plaintext'
  | 'point';
export type NodeShape = KnownNodeShape | (string & {});

// ===========================================================================
// 2. 几何原语
// ===========================================================================

/** 2D 点；边路由的最新点、端口锚点等都用它。 */
export interface Point {
  x: number;
  y: number;
}

/** top-left 矩形；节点/端口/label 的几何。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ===========================================================================
// 3. 实体
// ===========================================================================

/**
 * 端口。ELK 一等公民；Graphviz 用 `node:port:compass` 近似；mermaid / d3 无。
 * `name` 只需在所属节点内唯一（ELK adapter 会加节点前缀做文档级唯一 id）。
 */
export interface GraphPort {
  name: string;
  /** 数据流向建议。 */
  direction?: PortDirection;
  /** 贴边方位；与 direction 二选一或并用，适配器按引擎能力取用。 */
  side?: PortSide;
  label?: string | null;
  /** 同节点内端口的确定性顺序（避免依赖数组顺序，利于 diff）。 */
  index?: number;
  /** 布局输出：端口相对所属节点的左上角坐标。 */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  data?: JsonValue;
}

/**
 * 节点。同时表达「图元」与「分组」（有孩子者即 subgraph/cluster）。
 */
export interface GraphNode<N extends object = NodeData> {
  /** 稳定主键。SCIP 场景用 **SCIP symbol string**；mermaid/graphviz 场景用其原生 id。 */
  id: string;
  /**
   * 领域类别（自由字符串）：如 `'function' | 'method' | 'class' | 'module'
   * | 'file' | 'group'`。中性 IR 不解释含义，渲染器可据此选默认形状/配色。
   */
  kind?: string;
  /**
   * 所属分组节点 id。null/undefined = 顶层。
   * 映射：mermaid `subgraph`、graphviz `subgraph cluster_*`、ELK `children`、xyflow `parentId`。
   */
  parentId?: string | null;
  /** 展示名。mermaid `A[label]` 的 label；graphviz `label=`。 */
  label?: string | null;
  /** 形状；缺省由渲染器按 kind 决定。 */
  shape?: NodeShape;
  ports?: GraphPort[];
  /** 主色（可选；更细粒度用 style）。 */
  color?: string;
  style?: Style;

  // --- 几何（未布局时为 undefined；布局后由 VisualGraphNode 补全） ---
  /** 左上角 x；子节点相对父节点内容区。 */
  x?: number;
  y?: number;
  width?: number;
  height?: number;

  /** 领域负载：SCIP symbol、range、weight…（一等字段只放跨方言通用的那些）。
   *  渲染器私有状态（折叠、选中、配色…）也放这里，IR 不解释。 */
  data?: N;
}

/**
 * 边。**恰好一个 source、一个 target**（不支持超边）。
 *
 * 关于 `x/y/width/height`：在边上它们恒为 **label 矩形**，不是边的包围盒。
 * - `width/height` 是**输入**（渲染器测得 label 尺寸）；
 * - `x/y` 是**输出**（引擎放置后的左上角；dagre/graphviz 给中心，适配器换算）。
 * 边的实际路径在 `points`，包围盒可由 `points` 求得。
 */
export interface GraphEdge<E extends object = EdgeData> {
  /**
   * 稳定主键。建议合成 `${sourceId}->${targetId}#${kind}`（可加 port 消歧），
   * 使「同一对端点的调用次数变化」体现为 data 变化而非 add+remove。
   */
  id: string;
  sourceId: string;
  targetId: string;
  /** 源/目标端口名（ELK ports、graphviz `a:port`）。缺省 = 直接连节点。 */
  sourcePort?: string;
  targetPort?: string;
  /** 领域类别：如 `'calls' | 'imports' | 'implements' | 'transition'`。 */
  kind?: string;
  label?: string | null;
  /** 边级有向性覆盖；缺省继承图级 mode。 */
  mode?: GraphMode;
  /** 权重（最短路 / MST 等）；中性语义，不参与布局除非适配器取用。 */
  weight?: number;
  color?: string;
  style?: Style;

  // --- 路由（布局输出） ---
  /** 路径点，**含两端端点**，顺序 tail→head。解释见 routing。 */
  points?: Point[];
  /** 缺省 = 直线。 */
  routing?: EdgeRouting;

  // --- label 矩形（既是输入也是输出，见类型注释） ---
  x?: number;
  y?: number;
  width?: number;
  height?: number;

  data?: E;
}

/**
 * 图。未布局态。布局后请用 `VisualGraph`。
 */
export interface Graph<
  N extends object = NodeData,
  E extends object = EdgeData,
  G = GraphData,
> {
  /** 版本化 schema id，例如 `'gpen-scip-graph/2'`、`'gpen-graph/1'`。必填、参与校验。 */
  schema: string;
  id: string;
  /** 图级默认有向性。 */
  mode: GraphMode;
  /** 布局主轴；布局前可给，缺省 'down'。 */
  direction?: GraphDirection;
  nodes: GraphNode<N>[];
  edges: GraphEdge<E>[];
  /** 图级领域负载。 */
  data?: G;
  /** 出处/新鲜度。注意：**易变字段（时间戳）会破坏 git diff**，默认不写。 */
  provenance?: Provenance;
}

/** 产物出处；用于缓存新鲜度校验（covers()）与审计，不参与图语义。 */
export interface Provenance {
  /** 生产者，如 `'scip-graph/derive@0.1.0'`、`'mermaid@11'`。 */
  producer?: string;
  /**
   * 源版本。`git` 用 commit hash（不可变）；`jj` 的 change id 会随 amend 变，
   * 故与 commit 分列；两者可同时给。
   */
  revision?: { git?: string; jj?: string };
  /** 源内容摘要（如 scip index 的 hash），做缓存失效判断。 */
  sourceDigest?: string;
  /** ISO 时间戳。默认不写入，以保持产物可复现。 */
  generatedAt?: string;
}

// ===========================================================================
// 4. 已布局态（所有几何必填）
// ===========================================================================

export interface VisualGraphPort extends GraphPort {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualGraphNode<N extends object = NodeData>
  extends GraphNode<N> {
  x: number;
  y: number;
  width: number;
  height: number;
  ports?: VisualGraphPort[];
}

/** 已布局边：`x/y/w/h` = label 矩形（无 label 时可全 0）。 */
export interface VisualGraphEdge<E extends object = EdgeData>
  extends GraphEdge<E> {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VisualGraph<
  N extends object = NodeData,
  E extends object = EdgeData,
  G = GraphData,
> extends Omit<Graph<N, E, G>, 'nodes' | 'edges' | 'direction'> {
  direction: GraphDirection;
  nodes: VisualGraphNode<N>[];
  edges: VisualGraphEdge<E>[];
}

// ===========================================================================
// 5. 领域特化示例（SCIP call graph）
// ===========================================================================

export interface ScipNodeData {
  /** 完整 SCIP symbol string（= 节点主键语义）。 */
  symbol: string;
  kind: 'function' | 'method' | 'class' | 'interface' | 'module' | 'file';
  file: string;
  /** 1-based。 */
  line: number;
  /** 1-based line/col 范围，供 jump-to-source。 */
  range?: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  /** 度数（in+out，自环计一次）——驱动节点尺寸。 */
  weight?: number;
  svelte?: boolean;
}

export interface ScipEdgeData {
  dispatch: 'static' | 'virtual' | 'self';
  confidence: number;
  /** 同一 (from,to,dispatch) 的调用点数量。 */
  calls: number;
  /** 调用点，供 refs 查询/跳转。 */
  sites?: { file: string; line: number }[];
}

export type ScipGraph = Graph<ScipNodeData, ScipEdgeData, { tool: string; revision?: string }>;
export type ScipVisualGraph = VisualGraph<ScipNodeData, ScipEdgeData, { tool: string; revision?: string }>;

// ===========================================================================
// 6. 规范化序列化契约（canonical form，服务于 git diff / 缓存 key）
// ===========================================================================
//
// 类型无法强制，但实现必须遵守，否则 `git diff` 会全是噪声：
//
//  - `nodes` 按 `id` 升序；`edges` 按 `id` 升序；`ports` 按 `index ?? name` 升序。
//  - 对象 key 顺序固定（写一个 `canonicalize(graph)` 走白名单字段序，而非
//    `Object.keys` 顺序）。
//  - 数值：坐标保留固定小数位（建议 3 位）并去掉 `-0`；整数不写 `.0`。
//  - 省略 `undefined`（JSON 本来也会丢，但 `null` 要显式区分）。
//  - 不写 `provenance.generatedAt`，除非调用方显式要求。
//  - 比较时：布局相关键（x/y/width/height/points/routing）单列，
//    以便区分「内容变更」与「重布局」（isLayoutEqual 思路）。

/** 参与布局（而非内容）比较的键集合；diff 分类用。 */
export const LAYOUT_KEYS = {
  node: ['x', 'y', 'width', 'height'],
  edge: ['x', 'y', 'width', 'height', 'points', 'routing'],
  port: ['x', 'y', 'width', 'height'],
} as const;

// ===========================================================================
// 7. 布局适配器契约（引擎无关；ELK / Graphviz / dagre / d3-force …）
// ===========================================================================

export interface LayoutSpacing {
  /** 同层节点间距。ELK `elk.spacing.nodeNode`；dagre `nodesep`；graphviz `nodesep`(inch)。 */
  node?: number;
  /** 层间距。ELK `layered.spacing.nodeNodeBetweenLayers`；dagre/graphviz `ranksep`。 */
  layer?: number;
  /** 边与节点/边的间距。 */
  edge?: number;
}

export interface LayoutOptions {
  direction?: GraphDirection;
  spacing?: LayoutSpacing;
  /**
   * 渲染器负责文本测量；布局引擎需要尺寸，IR 不猜。
   * 解析顺序：measure → 节点自身 width/height → DEFAULT_NODE_SIZE。
   */
  measure?: (node: GraphNode) => { width: number; height: number };
  /** 固定节点（保留当前 x/y）。ELK/dagre/graphviz 不支持。 */
  isFixed?: (node: GraphNode) => boolean;
  /** 可移植的**建议性**约束；不支持的引擎忽略。 */
  constraints?: { layer?: (node: GraphNode) => number | undefined };
  /** 随机引擎的确定性种子（d3-force randomSource、ELK randomSeed）。 */
  seed?: number;
  /** 退出通道：原始引擎参数，**最后合并、覆盖一切**。不要存进 IR。 */
  engineOptions?: Record<string, string | number | boolean>;
}

/** 一次性布局（同步或异步）。输入不被 mutate。 */
export type LayoutFn<O extends LayoutOptions = LayoutOptions> = (
  graph: Graph | VisualGraph,
  options?: O,
) => VisualGraph | Promise<VisualGraph>;

/** 单帧：仅位置变更，非结构性。 */
export interface LayoutFrame {
  positions: Record<string, Point>;
  /** 冷却参数（物理引擎 1→0）；一次性引擎可恒为 0。 */
  alpha: number;
}

/** 迭代式布局（d3-force / ForceAtlas2 / WebCola）：每 `next()` 一 tick。 */
export type IterativeLayoutFn<O extends LayoutOptions = LayoutOptions> = (
  graph: Graph | VisualGraph,
  options?: O,
) => Generator<LayoutFrame, VisualGraph, void>;

/** 引擎能力声明；UI 据此禁用不支持的选项。 */
export interface LayoutEngineCapabilities {
  hierarchy: boolean;
  ports: boolean;
  edgeRouting: false | EdgeRouting[];
  direction: boolean;
  pinned: boolean;
  incremental: boolean;
  iterative: boolean;
  deterministic: boolean;
}

export interface LayoutEngine {
  id: string;
  capabilities: LayoutEngineCapabilities;
  layout: LayoutFn;
}

// ===========================================================================
// 8. 格式适配器契约（mermaid / dot / d2 / xyflow / elkgraph-json / graphml…）
// ===========================================================================

/** 该格式是只能读、只能写，还是双向。 */
export type FormatIo = 'input' | 'output' | 'both';

export interface GraphFormatConverter<F> {
  id: string;
  io: FormatIo;
  /** 外部方言 → 中立 IR。 */
  from(format: F, ...rest: unknown[]): Graph;
  /** 中立 IR → 外部方言。 */
  to(graph: Graph | VisualGraph, ...rest: unknown[]): F;
}
