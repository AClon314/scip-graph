# scip-graph 文档索引

本目录收录 `scip-graph` 仓库的工具文档，以及从 gpen-js `rules/scip/` 迁移过来的
**历史 PoC 记录**。查询 CLI 已迁到本仓库的 strict TypeScript 模块
（`src/bin/scip-graph.ts` + `src/lib/query/**`），派生脚本为 `scripts/derive-graph.ts`。

> **fork 索引器**：`.svelte` 支持与 callee / enclosing-range 补丁在 scip-typescript 的
> fork <https://github.com/AClon314/scip-typescript>（`gpen` 分支）。gpen-js 以 git
> submodule 形式挂在 `rules/scip-typescript`；构建与运行见 [`fork-build.md`](fork-build.md)。

## 当前工具

| 文档                                | 内容                                                                 |
| ----------------------------------- | -------------------------------------------------------------------- |
| [`query-cli.md`](query-cli.md)      | `bun src/bin/scip-graph.ts` 的 `callers`/`callees`/`impact`/`refs`/`boundaries` 用法、选择器、`--json` 契约、mermaid/dot 导出 |
| [`query-verification.md`](query-verification.md) | 对真实 `static/graph.json` 跑出的验证记录（精确计数） |
| [`fork-build.md`](fork-build.md)    | scip-typescript fork 的 Svelte + callee 补丁、构建、索引，以及派生查看器图 |

## 历史 PoC（原 gpen-js `rules/scip/`）

| 文档                                  | 原文件                    | 内容                                                     |
| ------------------------------------- | ------------------------- | -------------------------------------------------------- |
| [`scip-index-poc.md`](scip-index-poc.md) | `README.md`            | Track D：scip-typescript 符号级 def/ref、跨 repo link、成本/幂等、与 Jelly 的互补性 |
| [`poc-callee.md`](poc-callee.md)      | `README-callee-poc.md`    | Track F：callee 补丁的召回/精度（43.4%→60.0% 等）        |
| [`poc-svelte.md`](poc-svelte.md)      | `README-svelte-poc.md`    | Svelte 覆盖度 PoC（38/38 `.svelte` 文档、Q3 对齐）       |

历史文档中的 `.py` 脚本（`analyze.py` / `callee-poc.py` / `svelte-poc.py` /
`cross-repo.py` / `derive-graph.py`）与 `rules/out/` 产物仍留在 gpen-js，未随文档迁移；
本仓库用 `scripts/derive-graph.ts` 完成等价的派生。
