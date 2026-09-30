# scip-graph — SCIP 调用图查询 / 导出 CLI

> 数据来自 fork 版 scip-typescript（Svelte + callee 补丁；构建见
> [`fork-build.md`](fork-build.md)），由 [`scripts/derive-graph.ts`](../scripts/derive-graph.ts)
> 派生为 `static/graph.json`（1780 节点 / 2001 边）。
> 可视化由本仓库的 `src/routes/global` / `src/routes/local` SvelteKit 视图提供。
> 历史背景（gpen-js 的 Track D/E/F）见 [`scip-index-poc.md`](scip-index-poc.md)。

## 一句话

一把**只读 `static/graph.json`** 的查询工具：`callers` / `callees` / `impact`
做可达性，`refs` 列调用点，`boundaries` 汇总解析不到 in-repo 定义的调用点；
`--json` 是唯一机器契约，另可导出 mermaid / `.dot` 聚焦子图。

## 命令

```bash
bun src/bin/scip-graph.ts <子命令> <选择器> [选项]
# 或（package.json 已加脚本）
bun run scip-graph -- callers <选择器> [--depth N]
bun run scip-graph -- callees <选择器> [--depth N]
bun run scip-graph -- impact  <选择器> [--depth N]
bun run scip-graph -- refs    <选择器>
bun run scip-graph -- boundaries [--symbol S] [--file G] [--limit N]
```

| 子命令       | 含义                                               | 关键输出                            |
| ------------ | -------------------------------------------------- | ----------------------------------- |
| `callers`    | 反向可达：谁（间接）调用它                         | `results`（含 `distance`）+ `edges` |
| `callees`    | 正向可达：它（间接）调用了谁                       | 同上                                |
| `impact`     | 双向可达（受影响 + 依赖）                          | 同上                                |
| `refs`       | 该节点全部调用点（读 `edge.sites`，入站/出站）     | `results:{incoming,outgoing}`       |
| `boundaries` | 解析不到 in-repo 定义的调用点（读 fork SCIP 索引） | `results` + `breakdown`             |

### 选择器

| 形式            | 规则                                                |
| --------------- | --------------------------------------------------- |
| `<file>:<line>` | 精确 node id（与 `scip-graph.json` / Jelly 同口径） |
| `<file>`        | 整文件全部节点（glob，如 `src/lib/**/*.ts`）        |
| `<name>`        | 先精确匹配 `node.name`，再大小写不敏感子串          |

同名歧义（如 5 个 `commit`）→ stderr 列候选、退出码 1，**不会静默取第一个**。
未命中 → 退出码 1；用法错误 → 退出码 2；`boundaries` 缺索引 → 退出码 3。

### 选项

| 选项                              | 说明                                                                      |
| --------------------------------- | ------------------------------------------------------------------------- |
| `--json`                          | 稳定 JSON 信封（见下），stdout 无其他输出，诊断走 stderr                  |
| `--depth N`                       | 可达性 BFS 层数，默认 1（`0` = 只看目标自身）                             |
| `--format mermaid\|dot`           | 导出聚焦子图：mermaid 是 Markdown 代码块里的 `flowchart`；dot 是 Graphviz |
| `--out <file>`                    | 导出落盘（否则打到 stdout）                                               |
| `--graph <path>`                  | 换输入图，默认 `static/graph.json`（cwd 相对）                           |
| `--index <path>`                  | `boundaries` 的输入索引，默认 `rules/out/.cache/scip/index-fork.json`（cwd 相对） |
| `--symbol` / `--file` / `--limit` | 仅 `boundaries`：按 callee 名 / 文件 glob / 条数过滤                      |

## `--json` 契约

可达性（`callers` / `callees` / `impact`）：

```jsonc
{
  "query": "callers", "selector": "src/lib/components/areas/CodeArea.svelte:86",
  "depth": 1, "count": 2,
  "results": [{ "id": "...:86", "name": "commit", "file": "...", "line": 86, "kind": "Function", "distance": 0 }, ...],
  "edges": [{ "from": "...:115", "to": "...:86", "dispatch": "static", "calls": 1 }]
}
```

`refs`：

```jsonc
{
  "query": "refs", "selector": "...:86", "count": 2,
  "results": {
    "incoming": [{ "direction": "in", "other": { "id": "...:115", "name": "handleKeydown", ... },
                   "dispatch": "static", "confidence": 1, "calls": 1,
                   "sites": [{ "file": "...", "line": 119, "column": 2 }] }],
    "outgoing": [ /* 同上，direction: "out" */ ]
  }
}
```

`boundaries`：

```jsonc
{
  "query": "boundaries", "selector": null, "limit": null, "count": 4145,
  "results": [{ "file": "src/embed/index.ts", "line": 41, "column": 24,
                "callee": "Document#createElement",
                "symbol": "scip-typescript npm typescript 6.0.3 lib/`lib.dom.d.ts`/Document#createElement().",
                "kind": "builtins" }],
  "breakdown": { "byKind": { "builtins": 2931, "runes": 948, "node_modules": 266 },
                 "topCallees": [{ "name": "$state", "count": 456 }, ...] }
}
```

结果按稳定键（id / file:line）排序，可 diff。

## 实测

````bash
$ bun src/bin/scip-graph.ts callers "src/lib/components/areas/CodeArea.svelte:86" --json
# count=2：commit(:86) ← handleKeydown(CodeArea.svelte:115)   # Q3 对齐 Jelly
$ bun src/bin/scip-graph.ts refs "src/lib/components/areas/CodeArea.svelte:86"
# 入站 1：handleKeydown ← @119:2（static）
# 出站 1：write(source.ts:33) @91:11（virtual）
$ bun src/bin/scip-graph.ts boundaries --json
# 4145 处；builtins×2931 / runes×948 / node_modules×266
# Top callee：$state×456  String×407  $derived×220  Error×186  $effect×144 …
$ bun src/bin/scip-graph.ts impact "src/lib/components/areas/CodeArea.svelte:86" --depth 2 --format mermaid
# ```mermaid flowchart LR  n1 --> n0 ; n0 --> n2 ```
$ bun src/bin/scip-graph.ts impact "src/lib/components/areas/CodeArea.svelte:86" --depth 2 --format dot --out /tmp/q3.dot
$ dot -Tsvg /tmp/q3.dot -o /tmp/q3.svg      # graphviz 接受
````

## `boundaries` 口径与局限

- 读 fork 索引里 `syntax_kind == 15`（函数引用/调用）中 **callee 落不到 in-repo 定义**的 occurrence。
- 粗分类：`runes`（`$` 前缀，`$state`/`$derived`/`$effect`/`$props`/`$bindable`…）、
  `builtins`（`String`/`Error`/`Math`/DOM 类型等）、`node_modules`（`npm …` 符号）、`unclassified`。
  这与 Jelly 的 A/B/C1/C2/D/I/U/9 分类**不是同一套**，只是 scip 侧的近似分组。
- 4145 处里大头是 JS 内建与 Svelte rune（rune 是编译期宏），**不是缺失索引**；
  真正值得追的未解析边要看 `node_modules` / `unclassified`。

## 产物 / 依赖

| 路径                                    | 说明                                                  |
| --------------------------------------- | ----------------------------------------------------- |
| `src/bin/scip-graph.ts` + `src/lib/query/**` | CLI（strict TS，仅用 Node 内置模块，无运行期依赖） |
| `static/graph.json`                     | 输入图（由 `scripts/derive-graph.ts` 生成，gitignore） |
| `rules/out/.cache/scip/index-fork.json` | `boundaries` 输入（gitignore 缓存）                    |

> 索引缺失时 `boundaries` 仍返回空 `--json` 信封 + stderr 提示（退出码 3），
> 其余子命令不依赖索引。
