# scip-symbol-graph 评测与取舍（对 `rules/scip-graph` 的启示）

> 输入：[`taber-miyauchi/scip-symbol-graph`](https://github.com/taber-miyauchi/scip-symbol-graph)
> 本地：`rules/scip-symbol-graph`（git submodule，pin 在 `6f12675`「Initial commit: SCIP symbol graph prototype」）
> 对照：本仓库 `rules/scip-graph`（`gpen-scip-graph/1` 调用图查看器 + 查询 CLI）
> 数据基线：`rules/out/.cache/scip/index-fork.json`（本仓库 fork 索引，163 文档 / 6037 符号 / 40488 occurrence）

## 0. 结论（一句话）

对方是**「SCIP 符号结构图」的 Phase-1 原型**：用一条 Sourcegraph symbol 查询拉取符号，再从
SCIP symbol 字符串**直接解析**出 `CONTAINS`（module⊃class⊃method⊃field）与
`EXTENDS/IMPLEMENTS` 边，并用引用探针标「死代码」。**它的产品内核是「结构透镜」，我们的是
「调用透镜」——两者互补而非替代。**

- **取**：`CONTAINS` 结构边 + 全定义节点集 + 引用计数/死代码标记 + 外部/合成节点区分
  + 边类型筛选/图例这套交互。这些全部可由**本地 SCIP 索引精确派生**，不引入任何外部依赖。
- **舍**：Sourcegraph GraphQL / token / `codeGraphData` / `usagesForSymbol` / `lsif` 这条
  **在线、非幂等、实验 API** 的取数链；以及它「不做调用图」的 Phase-1 自我阉割。
- 已落地的第一步：把它的核心解析器（`app/scip.py`）忠实移植为
  `src/lib/graph/scip-symbol.ts` + `test/scip-symbol.test.ts`（21 单测全绿，含对真实 fork
  索引 6037 个符号的往返/无环校验）。

## 1. 它是什么（产品大纲）

### 1.1 定位

「把一段代码里的**符号及其精确关系**画成蛛网」。输入一条 Sourcegraph 查询（如
`repo:^github\.com/...$ type:symbol /.*/ -lang:markdown`），输出一张可交互网络：每个
class / function / method / variable 是节点，边是**精确**（非启发式）关系。

### 1.2 数据管线（5 步，README 自述 + 源码核对）

| 步骤 | 调用 | 产出 |
| ---- | ---- | ---- |
| 1 | `search(type:symbol)` | 符号节点（name/kind/location） |
| 2 | `codeGraphData.occurrences`（每文件一次） | 每个节点的 SCIP symbol 串 + 精确 range |
| 3 | **解析 SCIP descriptor**（`app/scip.py`） | `CONTAINS` 边（无额外 API 调用） |
| 4 | `usagesForSymbol`（仅 class-like） | `EXTENDS` / `IMPLEMENTS` 边 |
| 5 | `lsif.references(first:1)`（每符号一次探针） | `reference_status: used/dead` |

> **关键洞察**：SCIP symbol 串本身编码了完整包含层级——
> `scip-python python order-service 2.1.0 \`order_service.errors\`/AppError#__init__().(message)`
> 里 `namespace / type / method / parameter` 后缀直接给出 module⊃class⊃method⊃param。
> 所以结构边**零额外 API 调用**，只需字符串解析。这是本原型最有价值的部分。

### 1.3 数据模型

```jsonc
// node
{ "id", "label", "kind", "scip_symbol", "repo", "path", "line",
  "synthetic": bool, "external": bool,
  "precision": "precise" | "search_only" | "synthetic",
  "reference_status": "used" | "dead" | "unknown" | "n/a" }
// edge
{ "id", "source", "target", "type": "CONTAINS" | "EXTENDS" | "IMPLEMENTS",
  "confidence": "precise" }
```

- `CONTAINS` 的父级若不在搜索结果里，会**补合成节点**（module/package，`synthetic:true`）。
- `EXTENDS` 的目标若不在结果里，补 `external:true` 节点，`precision:"precise"`。
- `reference_status` 仅对真实节点探测；合成/外部节点为 `n/a`。

### 1.4 界面（单文件 `static/index.html`，Cytoscape.js + fcose，CDN 加载）

- **节点编码**：按 kind 着色（class 橙 / func 绿 / var 紫 / module 灰 / external 橙描边虚线）、
  按 kind 定尺寸、`dead` 红描边、`synthetic` 半透明圆角矩形、`external` 虚线边框；选中白描边。
- **边编码**：contains 灰、extends 蓝粗、implements 紫虚线，带箭头。
- **筛选**：`CONTAINS` / `EXTENDS+IMPLEMENTS` / `synthetic` / `dead-only` 四个开关。
- **选中面板**：label + used/dead 徽标、kind、lang、file:line、repo、precision、原始 `scip` 串，
  以及 **Open in Sourcegraph ↗** 深链（`{SG_URL}/{repo}@{rev}/-/blob/{path}?L{line}:{col}`）。
- **操作**：Build graph（回车触发）/ Re-layout。

### 1.5 技术栈与运维

- Python ≥3.9：FastAPI 0.115 + uvicorn + httpx + python-dotenv；`run.sh` 一键建 venv 并起在
  `127.0.0.1:8010`。
- 配置：`SG_URL` / `SG_TOKEN` 必填，`SG_CONCURRENCY`(10) / `SG_MAX_SYMBOLS`(1500) / `PORT` 可选。
- 无测试、无构建、无持久化；前端走 CDN。

### 1.6 明确的能力边界（作者自述）

- 依赖目标仓库有**精确 SCIP 索引**；否则节点退化为 `search_only`（无包含边）。
- 语言内建 / stdlib 通常无法精确解析。
- `codeGraphData` / `usagesForSymbol` 是**实验 API**；引用计数用 legacy `lsif.references`。
- **不做 caller→callee 调用边**（自认需要启发式，列在 Roadmap Phase 2）。

## 2. 实测记录（本机）

| 项目 | 方法 | 结果 |
| ---- | ---- | ---- |
| 依赖安装 | `uv venv --python 3.11` + `uv pip install -r requirements.txt` | ✅ 全部按 pin 装成（fastapi 0.115.6 / httpx 0.28.1 / uvicorn 0.34.0） |
| 服务启动 | `SG_URL=… SG_TOKEN=dummy uvicorn app.main:app --port 8010` | ✅ 正常起 |
| `GET /api/config` | curl | ✅ `{"sg_url":"https://sourcegraph.com"}` |
| `GET /` | curl | ✅ HTTP 200，12127 bytes 静态页 |
| `POST /api/graph` 空查询 | curl | ✅ 400 `Query must not be empty.` |
| `POST /api/graph` 假 token | curl | ❌ **HTTP 500** + traceback：`httpx.HTTPStatusError: 401` 未被捕获（`main.py:28` 只接 `ConfigError`/`SourcegraphError`，`_graphql` 的 `raise_for_status()` 直接冒泡）。应返回 401/502。 |
| 前端加载 | `agent-browser open` + eval | ✅ 标题正确，`window.cy` 已建，`cytoscape`/`cytoscapeFcose` 均从 CDN 就位；仅一条 wheelSensitivity 警告 |
| **解析器离线实测** | 用 `app/scip.py` 跑真实 fork 索引全部 6037 个符号 | ✅ **0 解析错误**；365 个 `local`；5672 个有父级；5243 个父级能在本仓定义中落地，429 个落空（外部/内建）；链长 2–10，均值 6.26；leaf kind 分布 `META 1529 / PARAMETER 1444 / VARIABLE 1421 / METHOD 1009 / CLASS 350 / MODULE 166 / TYPE_PARAMETER 118` |

> 结论：解析器本身**健壮且精确**，可在完全离线（无 Sourcegraph）场景下复用；在线取数链因
> 无 token / 依赖实验 API，**不可复现**，不构成工程依赖。

### 2.1 产出与离线预览（无需 token）

对方的产品产出有两层：

1. **API 产出**：`POST /api/graph` 返回
   `{ query, effective_query, stats{node_count,edge_count,dead_nodes,precise_nodes,symbols_found,file_count,warnings,truncated}, nodes[], edges[] }`。
2. **可视化产出**：同一份 JSON 被前端渲染成一张 Cytoscape 蛛网（节点按 kind 配色/尺寸，
   `dead` 红描边，`synthetic` 半透明，边按 CONTAINS/EXTENDS/IMPLEMENTS 分色，右侧选中面板
   展示原始 SCIP 串）。

要预览，上游默认路径需要 `SG_URL`+`SG_TOKEN`（我们无 token），但**结构边的取数与 Sourcegraph 无关**——
它只依赖 SCIP symbol 串。因此我们用本仓本地索引搭了一个离线桥（throwaway，落在 gitignored
`rules/out/.cache/ssg-preview/server.py`）：

```sh
python3 rules/out/.cache/ssg-preview/server.py        # http://127.0.0.1:8011/
# 浏览器打开后，输入框填子目录前缀（如 src/lib/commands/）→ Build graph
# 也支持在输入框写 `prefix:src/lib/layers/` 切换范围
```

它用 `app/scip.py` 解析 `rules/out/.cache/scip/index-fork.json`，只补 `CONTAINS`（+合成祖先）与
`dead`（本地 occurrence 计数），**不设 Sourcegraph**。实测 `src/lib/commands/`：
`131 节点 / 130 CONTAINS 边 / 51 dead / 126 precise / 3 文件`。

截图（`docs/shots/`）：

- [`ssg-offline-preview.png`](shots/ssg-offline-preview.png) — 全图
- [`ssg-dead-only.png`](shots/ssg-dead-only.png) — 「Only dead symbols」透镜
- [`ssg-selection-panel.png`](shots/ssg-selection-panel.png) — 选中死代码，面板显示完整 SCIP 串

> 注意：离线桥**无 EXTENDS/IMPLEMENTS**（本地索引不含 LSIF implementation 数据），
> 这正是我们 Phase C 要先验证可行性、不盲抄的原因（见 §6）。

## 3. 与 `rules/scip-graph` 的正面对比

我们当前图谱（`rules/out/scip-graph.json`，本仓库快照）：
`1780 nodes / 2001 edges / 15 self-loops / 303 virtual / 2196 call sites`，kinds
`Function 907 · Other 234 · Method 228 · Unknown 195 · Constant 98 · Property 85 · Module 24 · Constructor 8 · Class 1`。

| 维度 | scip-symbol-graph（对方） | scip-graph（我们） |
| ---- | ------------------------- | ------------------ |
| 取数 | **在线** Sourcegraph GraphQL，需 token；`codeGraphData`/`usagesForSymbol` 实验 API | **离线**本地 SCIP JSON 索引（fork scip-typescript），无网络无鉴权 |
| 可复现/幂等 | ❌ 依赖服务端版本与实时结果 | ✅ 派生幂等，产物可 diff |
| 节点集 | 搜索结果里**所有**符号 | **只包含参与调用边的节点**：4239 个非 local 定义里仅 1780 进图，缺 3269（Property 1972 / Other 681 / Interface 158 / Constant 153 / Module 137 / TypeAlias 121 …） |
| 结构边 | ✅ `CONTAINS` 纯解析可得；`EXTENDS/IMPLEMENTS` 来自 API | ❌ 无 |
| 调用边 | ❌ 明确不做（Roadmap Phase 2） | ✅ 精确：`calls` 计数、`sites` 调用点、(file,line) 口径、`static/virtual/self` dispatch |
| 死代码 | ✅ 每符号 `used/dead`（在线探针） | ❌ 无（但**可本地精确派生**：非定义 occurrence 计数） |
| 外部符号 | ✅ 一等的 `external` + 合成容器节点 | ⚠️ 落不到定义的 callee 进 `boundaries` CLI，**不进图**、无节点 |
| 继承 | ✅ `EXTENDS/IMPLEMENTS`（实验 API） | ❌ 无 |
| 规模/上限 | `SG_MAX_SYMBOLS=1500`，并发 10，受服务端限流 | 单人离线，图由索引规模决定（当前 1780 / 可到 4239+） |
| 视图 | 单张 fcose 蛛网 | 双视图：global 密度概览（d3-force worker、层级折叠、size-by-degree、outline 树、URL 选中同步、elk 预计算）+ local butterfly（hop、多焦点、键盘、编辑器 jump/sync） |
| 查询 | 只有 `/api/graph` JSON | `callers/callees/impact/refs/boundaries` CLI，`--json` 契约 + mermaid/dot 导出 |
| 交互细节 | 边类型开关、图例、kind 配色、dead-only、选中面板（含原始 SCIP 串 + 深链） | 层级折叠、size-by-degree、编辑器联动、快捷键、但**无边类型开关 / 无 dead 透镜 / 无 kind 图例** |
| 语言 | 取决于 Sourcegraph 覆盖（py/go/ts/…） | TS + `.svelte`（fork 索引器） |
| 工程化 | 单 commit 原型，0 测试，0 构建，CDN | submodule、11+10 单测、文档、预计算、健康门禁 |

**一句话**：对方把「符号结构」做对了、把「调用」留白了；我们把「调用」做深了、把「结构」留白了。
二者交集是「SCIP symbol 串」——**同一份数据，两种透镜**。

## 4. 取（可本地精确派生，建议采纳）

用真实索引量化过的收益（`index-fork.json`）：

| 采纳项 | 依据数据 | 价值 |
| ------ | -------- | ---- |
| **A. `CONTAINS` 结构边** | 4239 条可由 descriptor 直接派生，其中 3054 条父级落在本仓定义 | 零成本、精确、补齐「结构透镜」 |
| **B. 全定义节点集** | 现缺 3269 个定义节点（Property/Interface/TypeAlias/Module 为主） | 图从「调用参与者的图」升级为「符号图」；类/接口不再因无人调用而消失 |
| **C. 引用计数 + 死代码标记** | 5672 个非 local 定义中 **1841 个 0 引用** | 本地精确替代 `lsif.references` 探针；支撑 dead-only 透镜与 `unused` 查询 |
| **D. 外部/合成节点一等化** | 429 个父级落空 | 与 `boundaries` CLI 互补：图中显式呈现「指向仓库外」而非静默丢弃 |
| **E. 边类型筛选 + 图例 + kind 配色** | — | 结构边与调用边并存时必须可切换，否则图会糊 |
| **F. 选中面板展示原始 SCIP 串 + 深链** | 我们已有 `range` 和 `editor.ts` | 面板补 `scip_symbol` 与「在编辑器中打开」（已有 range，成本低） |

**已落地**：A 的前置——解析器移植 `src/lib/graph/scip-symbol.ts`
（`parseSymbol/parseDescriptors/parentSymbol/displayName/leafKind/descriptorChain/reassemble`）
+ `test/scip-symbol.test.ts`（21 测，含对真实索引 6037 符号的往返/无环校验；`bun test` 全绿，
`bun run check` 0 error）。

## 5. 舍（明确不采纳）

| 舍弃项 | 理由 |
| ------ | ---- |
| Sourcegraph GraphQL + `SG_TOKEN` | 引入在线依赖、鉴权、限流、不可复现；我们已有本地索引 |
| `codeGraphData` / `usagesForSymbol` | 实验 API，行为随服务端变化；`app/sourcegraph.py` 自己都在注释里纠结方向语义 |
| `lsif.references` 逐符号在线探针 | 可用本地 occurrence 计数精确替代（见 4.C） |
| **「不做调用图」** | 调用边是我们的差异化能力，不能回退 |
| Cytoscape + CDN 单文件前端 | 在 4000+ 节点规模下，我们的 canvas + worker + 预计算更合适 |
| `SG_MAX_SYMBOLS=1500` 截断 | 离线无此必要 |
| `search_only` 降级路径 | 离线场景无意义 |
| 未捕获异常直接 500（§2 实测） | 反面教材：错误要映射为 4xx/502，不能裸冒泡 |

## 6. 给 `rules/scip-graph` 的落地路线（分阶段，每阶段独立可验证）

> 原则：**先加能力、再加开关，最后才动默认视图**；每阶段跑绿 `bun test` + `bun run check`，
> 并用 `rules/out/.cache/scip/index-fork.json` 复算数字对账。

- **Phase A（结构层，schema 升 v2）**
  1. ✅ 解析器模块（本文件 §4 已落地）。
  2. `derive-graph.ts`：新增 `contains` 边（`parentSymbol` 链）与全部定义节点；
     schema 增 `SgEdge.type: 'call' | 'contains'`、`SgNode.refs`/`dead`/`external`。
  3. 查询库按边类型过滤（`callers`/`callees` 默认只走 `call`）；新增 `scip-graph unused` 子命令。
  - 验收：`contains` 边数 ≈ 4239（本仓），`dead` 节点数 ≈ 1841（按定义口径），
    `callers` 结果与旧版**逐条一致**（回归）。
- **Phase B（视图层）**：global/local 增边类型开关、kind 图例、dead-only 透镜、
  外部/合成节点样式；**默认仍只显示调用边**，结构边 opt-in（`?edges=contains,call`）。
  消融对照：加 3269 个非调用节点后，global 密度图是否更可读，还是纯噪声。
- **Phase C（继承，需先验证可行性）**：本地索引无 LSIF implementation 数据；
  评估「class 定义 `enclosing_range` 内的类型引用 = extends/implements」的启发式，
  `confidence < 1` 且默认关闭；或改 fork 索引器显式发实现角色。**在验证前不实现**。
- **Phase D（体验）**：选中面板补 `scip_symbol` 与编辑器深链；CLI 到「一键看图」的入口收敛。

## 7. 复现命令

```sh
# 对方（submodule 内）
cd rules/scip-symbol-graph
uv venv --python 3.11 .venv && uv pip install --python .venv/bin/python -r requirements.txt
SG_URL=https://sourcegraph.com SG_TOKEN=… .venv/bin/uvicorn app.main:app --port 8010
# 无 token 时只能验证：/api/config、静态页、400；/api/graph 会 500（见 §2）

# 我们的（submodule 内）
cd rules/scip-graph
bun test                       # 21 pass（含解析器）
bun run check                  # 0 error
bun run derive -- --scip ../out/.cache/scip/index-fork.json --out static/graph.json
bun run scip-graph -- callers "src/embed/index.ts:35" --json
```

## 8. 附：对方代码中的可疑点（供移植时避坑）

- `parent_symbol` 注释写「跳过尾部 meta」，代码却是通用 `descs[:-1]`——行为正确但注释误导；
  移植时已澄清为「丢最后一个 descriptor，meta 自标自然被跳过」。
- `main.py` 只捕获 `ConfigError`/`SourcegraphError`，`httpx` 的 401/超时会裸 500（§2 实测）。
- `_usages` 固定 `first: 200` 且不翻页，大基类会漏边。
- `IMPLEMENTS` 去重用 `frozenset((source,target))` 与 `EXTENDS` 比对——用启发式清理实验 API 的
  重复，属打补丁而非建模。
- 全仓 0 测试、0 CI；正确性只能靠线上观察。
