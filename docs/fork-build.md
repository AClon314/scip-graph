# gpen 专用 scip-typescript fork（Svelte + callee 补丁）

本文件记录 callee 补丁的**长期 fork 版**产物：在带上游 Svelte 支持的
scip-typescript 上叠加 gpen 的 callee/enclosing-range 补丁，并完成构建。

> 迁移说明：本文档原在 gpen-js `rules/scip/README-fork.md`。fork 索引器现作为
gpen-js 的子模块 `rules/scip-typescript`（`AClon314/scip-typescript` 的 `gpen` 分支），
下游仓库不再各自 clone/打补丁。

原先 `build-patched.sh` 的做法是「clone 上游 pin commit + `git apply` 补丁」。本 fork 把
上游三个 PR 栈合入后，再 rebase 我们的补丁，避免每次针对老 commit 打补丁。

- **Fork**：<https://github.com/AClon314/scip-typescript>
- **分支**：`gpen`（已 push，tracking `origin/gpen`）
- **本地工作树**：`rules/scip-typescript`（gpen-js 的 git submodule，指向 `gpen` 分支）

## 版本 SHA

| 项                           | SHA                                        | 说明                                                                                    |
| ---------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------- |
| `upstream/main`              | `e22988d9a80a5cfaa5ad3afbfbc99bab511fd24a` | 基线（v0.4.0，`Fix contextual shorthand property references (#478)`）                   |
| `upstream/svelte-indexing`   | `dcb9ad0d5fb6706275d81bcb6d461c9346192e3a` | #472 头分支，内含 #489 + #491（compare `main...svelte-indexing` = ahead 17 / behind 0） |
| 合并结果                     | `dcb9ad0d5fb6706275d81bcb6d461c9346192e3a` | `main` 是 `svelte-indexing` 的祖先，merge 为 **fast-forward**，无 merge commit          |
| callee 补丁提交（最终 HEAD） | `e42e263201e791aec1171b8603fec00398234f01` | `Apply gpen callee/enclosing-range patch`                                               |

上游关系 PR 栈：`#489`（`relationship-symbol-information`）→ `#491`
（`local-symbol-information`）→ `#472`（`svelte-indexing`，base 为 `local-symbol-information`）。
因此只合入 `svelte-indexing` 即可同时拿到三者。

## callee 补丁的合并方式

补丁源文件：`rules/scip/scip-typescript-callee.patch`（针对 `e22988d` 生成，只动
`src/FileIndexer.ts`；已合入 fork 的 `gpen` 分支，保留以便审阅增量）。用 `git apply --3way` 应用；#472 改了同一批区域，产生 1 处文本冲突、
其余按规则手工规整。**未重新引入被 #472 删除的 `Range` import。**

冲突与解决（逐条）：

1. **references 的 enclosing-range fallback（补丁 hunk `@@ -220`）**：补丁上下文原本是
   `enclosingRange = Range.fromNode(declaration).toLsif()`；#472 已改为
   `this.sourceInfo.range(declaration)`。解决：保留 `this.sourceInfo.range(...)`，
   `if (enclosingRange === undefined) enclosingRange = this.enclosingFunctionRange(node)`
   原样插入。（此 hunk 由 3-way 自动合并。）
2. **helper 方法插入点（补丁 hunk `@@ -362`）**：补丁把 `enclosingFunctionRange` /
   `callSyntaxKind` 插在 `private pushOccurrence` 前；#472 在同一锚点前新增了
   `pushSymbolInformation`（带 occurrence 去重）。两者在同一位置插入 → 冲突标记。解决：
   保留 #472 的 `pushSymbolInformation`（去重版）**和** 新增两个 helper，丢弃补丁上下文里
   夹带的旧版非去重 `pushOccurrence`（以 #472 的 `occurrenceKeys` 去重版为准）。
3. **helper 内部实现**：`enclosingFunctionRange` 中 `Range.fromNode(current).toLsif()`
   改为 `this.sourceInfo.range(current)`；若返回 `undefined` 则继续向上找祖先，最后回退到
   模块范围（整文件、起始 `line 0`，即 `[0, 0, lastLine, 0]`）。`callSyntaxKind` 逻辑不变。
4. **条件扩展（补丁 hunk `@@ -203`）**：`ts.isVariableDeclaration` 扩展为
   `(isVariableDeclaration || isPropertyAssignment || isPropertyDeclaration)`，干净应用。
5. **`syntax_kind`（补丁 hunk `@@ -243`）**：在构造 `scip.scip.Occurrence` 时加入
   `syntax_kind: FileIndexer.callSyntaxKind(node)`，与 `enclosing_range` / `range` /
   `symbol` / `symbol_roles` 并列，干净应用。

## 构建

```bash
cd rules/scip-typescript
bun install || true          # 上游用 yarn@1，本机无 yarn
node_modules/.bin/tsc -b .
```

`bun install` 会在 `prepare` 阶段因 `yarn: command not found` 退出 127（**预期，可忽略**，
`prepare` 只装 snapshots 子项目）；依赖已装好、`node_modules/.bin/tsc` 可用。

- **产物**：`rules/scip-typescript/dist/src/main.js`（入口，`package.json#bin`）
- 标记确认（`dist/` 树内）：`SourceInfo` 与 `callSyntaxKind` 均在
  `dist/src/FileIndexer.js`（`main.js` 经 `ProjectIndexer` 间接依赖）。

## 运行索引

```bash
node rules/scip-typescript/dist/src/main.js index \
  --cwd /home/n/document/code/gpen/gpen-js \
  --output /home/n/document/code/gpen/gpen-js/rules/out/.cache/scip/index-fork.scip
```

冒烟验证（小工程）确认补丁生效：callee 引用 occurrence 同时带
`"syntax_kind": 15`（`IdentifierFunction`）与 `"enclosing_range"`（最近的函数体），
且普通 REFERENCES 也带上了 `enclosing_range`。

## 派生查看器图（`static/graph.json`）

索引（`index-fork.json`）只适合查询，不适合喂布局/可视化。用 scip-graph 仓库的
`scripts/derive-graph.ts`（Python `derive-graph.py` 的 TS 移植）把它规整成扁平 schema
（`nodes[]` / `edges[]`，含 `kind/name/weight/dispatch/calls/sites`）：

```bash
bun run derive -- \
  --scip rules/out/.cache/scip/index-fork.json \
  --out  static/graph.json
# 1780 nodes / 2001 edges / 559 svelte edges / 303 virtual / 2196 call sites
```

- 口径与 `svelte-poc.py` 的 **scoped** 解析一致（`local N` 只在本文档内解析），
  故名次与 `scip-svelte-poc.json` 的 `scoped_unique_edges=2001` 完全一致。
- 只保留能解析到 in-repo 定义的边；解析不到的内建/rune 见 `bun run scip-graph -- boundaries`。
- 查询/导出见 [`query-cli.md`](query-cli.md)；可视化由本仓库的 `src/routes/global` /
  `src/routes/local` SvelteKit 视图提供。

## 可选：#469

上游 PR <https://github.com/sourcegraph/scip-typescript/pull/469>
（`fix: ensure enclosing ranges contain occurrences`，头分支 `ByteOverDev:fix/enclosing-range-containment`，
SHA `88cd7d64a0b61e39fa3b0f547b30abfa2e964332`，基于更老的 `891eb42`）**未合入**：
`git merge` 报冲突于 `src/FileIndexer.ts`（import 段 `Range`/`Position`、enclosing-range 区域）
与 `src/main.test.ts`（大段快照断言）。已 `git merge --abort`，未纳入 `gpen`。
