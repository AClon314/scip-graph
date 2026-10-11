# 1002 最终 Plan —— scip-graph 净室重构

> 这是**唯一**需要带进新仓库的结论文档。旧实现归档在 `AClon314/scip-graph@deprecated-202609`，不要再读。
> 参考产物（本目录，不入 repo）：`types.ts`（IR 类型）、`mid-ir.ts`（mock）、`ui-demo/`（共享 core + Svelte GUI + 自绘 TUI）、
> `ui-opentui/`（opentui TUI）、`graph-tui-libs/`（orchgraph/ascii-dag 对比 + 调参）、`vs-blarify-ckb.md`、`tui-libs/README.md`。

## 1. 目标

SCIP 派生的 **call graph 浏览器**：GUI-HTML + TUI 双面、可 `git/jj diff`、预留 mermaid/graphviz 兼容。

## 2. 已定技术决策（不要再重新论证）

| # | 决策 | 依据 |
|---|---|---|
| D1 | **中立 IR** `gpen-scip-graph/2`：symbol 主键、扁平+排序、`kind`/`dispatch`/`confidence`/`calls`、`edge.points[]+routing`、`edge.x/y/w/h`=label 矩形、`parentId` 表 subgraph | `types.ts` / `mid-ir.ts` |
| D2 | **ELK JSON 只做布局引擎边界**（adapter 内部 / 缓存产物），**不做 canonical** | ELK JSON 引擎专属 + 无图语义 + 不可 diff |
| D3 | 布局用 **ELK layered + 自写 engine 调参**；不 fork orchgraph | orchgraph 参数写死只暴露 `spacing`；注入 engine 后列间距降 20~45% |
| D4 | **TUI 图渲染 = orchgraph**（`renderTerminalGraph`→`renderTerminalCanvas`）；ascii-dag 太简、自绘路由差，均不用 | `graph-tui-libs/README.md` |
| D5 | **TUI chrome/布局/事件/鼠标 = opentui**；共享 view-model + reducer 自研；图用自定义 `Renderable`（`buffered` + `renderSelf`）复用 cell 绘制 | `ui-opentui/` 实测通过（键+鼠标） |
| D6 | **GUI-HTML = Svelte 5 + d3/canvas**，与 TUI 共享 view-model，不共享组件/布局 | `ui-demo/` |
| D7 | 不碰的库：svelterm（未合并 Svelte 分支）、janeway（REPL）、blarify/ckb（形态/许可不符） | `vs-blarify-ckb.md`、`tui-libs/README.md` |

## 3. 依赖

- 运行：`elkjs`（布局）、`orchgraph`（TUI 图）、`@opentui/core`（TUI chrome）、`svelte`（GUI）。
- 构建：`vite` + `@sveltejs/kit`。
- 其余（IR、canonical、derive、view-model、reducer、CLI）**自研**。

## 4. 模块划分（新 repo）

```
src/lib/ir/        类型 + canonical 序列化（types.ts 落地）
src/lib/parse/     SCIP index → IR（syntax_kind=IdentifierFunction 严筛；后续补 callback/computed/JSX）
src/lib/layout/    ELK engine（调参）+ IR→geometry
src/lib/core/      view-model（tree/legend/scene/status）+ 交互 reducer（框架无关）
src/lib/render-tui/  opentui chrome + orchgraph 图 + 自定义 GraphRenderable
src/lib/render-gui/  Svelte 组件 + d3/canvas
src/lib/query/     callers/callees/impact/refs/boundaries（JSON 契约）
bin/               CLI（--json 机器契约）
scripts/derive.ts  SCIP → static/graph.json
```

## 5. 验收线

- `derive` 产出合法 IR（symbol 主键、排序稳定）；`parse→IR→emit` 语义往返 fixture 通过。
- 1000 节点：布局耗时可接受、画布尺寸合理（不比 orchgraph 默认差）。
- TUI：键盘 + 鼠标可交互；GUI：`vite build` 通过。
- `bun test` / `bun run typecheck` 绿。

## 6. 里程碑

- **M1** 净室骨架 + IR + mock + GUI/TUI「hello」（本步）
- **M2** SCIP derive + 查询 CLI
- **M3** git/jj diff
- **M4** mermaid/graphviz 兼容（可选接 `@statelyai/graph` 的格式 adapter）

## 7. 版本管理

- 旧实现：`main` → 归档为 **`deprecated-202609`**（保留全部历史）。
- 新实现：干净的 `main`（orphan），后续用 **jujutsu（colocate）**。
