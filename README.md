# scip-graph（净室重构）

SCIP 派生的 call graph 浏览器：GUI-HTML + TUI 双面、可 `git/jj diff`、预留 mermaid/graphviz 兼容。

**设计与决策见 [`docs/PLAN.md`](docs/PLAN.md)（唯一权威）。**

## 来源 / 归档

这是 **净室重写**，与旧实现无 git 血缘。

- 旧实现归档：分支 `deprecated-202609`、tag `legacy-202609`，旧 `main` SHA `4483ebc9e3280ff38eaa6789124dccf7f247fdd6`。
- **不要读 `deprecated-202609`**，避免污染新代码上下文。

## 结构（M1）

```
src/lib/ir/         中立 IR：types.ts（gpen-scip-graph/2）+ mock.ts
src/lib/core/       框架无关共享层：model.ts（view-model）/ from-ir.ts / app.ts（reducer）/ keys.ts
src/lib/render/tui/ 字符格光栅化：cell.ts（CellBuffer）/ render.ts（paintScene / renderTui）
src/lib/render/gui/ Svelte 5 组件：FileTree / GraphPanel / StatusBar / InputBar
src/lib/layout/     orchgraph 布局适配（stretch，未接入主流程）
src/routes/         SvelteKit GUI 宿主（+page.svelte 用上面的组件）
src/tui/main.ts     TUI 入口（opentui chrome + 自定义 GraphRenderable）
tests/core.test.ts  view-model / reducer / rasterizer 单测
```

两条渲染路径共享 `src/lib/core`（数据 + view-model + reducer），**不共享组件**：
GUI 用 Svelte/SVG，TUI 用 opentui + 自绘 CellBuffer。

## 命令

```sh
bun install            # 独立安装依赖
bun run typecheck      # tsc --noEmit
bun test               # view-model / reducer / rasterizer 单测
bun run build          # SvelteKit 静态构建（输出 build/）
bun run tui            # 交互 TUI（真实 TTY；键 + 鼠标）
bun run tui:headless   # 无 TTY：渲染一帧字符帧
bun run tui:headless -- --keys "down down enter tab"   # 回放按键
bun run tui:headless -- --click 75,9                   # 模拟鼠标点节点
```

## 状态

- **M1** 净室骨架 + IR + mock + GUI/TUI「hello」：已完成。
- **M2** SCIP derive + 查询 CLI；**M3** git/jj diff；**M4** mermaid/graphviz 兼容。见 `docs/PLAN.md` §6。
