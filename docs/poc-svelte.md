# Svelte 覆盖度 PoC — fork 版 scip-typescript vs Jelly

> 迁移说明：本文档原在 gpen-js `rules/scip/README-svelte-poc.md`，记录历史 PoC；
> 其中的 `.py` 指标脚本留在 gpen-js，不在本仓库。

> 上游背景与 callee 补丁见 [`poc-callee.md`](poc-callee.md)；fork 产物与构建见
> [`fork-build.md`](fork-build.md)。本文件只回答一个问题：**带 Svelte 支持 + gpen callee
> 补丁的 fork，能否覆盖 gpen 的 `.svelte` 组件。**
> 脚本：`svelte-poc.py`；原始数字：gpen-js 的 `rules/out/scip-svelte-poc.json`。

## 一句话结论

**Svelte 支持确实生效、且端到端可用，但覆盖度与非 Svelte 代码同档（召回六成上下），不是「接上就能替代 Jelly」。**
索引出 **38 个 `.svelte` 文档（与 Jelly 的 38 个 svelte 文件完全一致）**，svelte 函数节点精度
**99.0%**、召回 **57.0%**；svelte 调用边 **召回 60.0%、精度 66.0%**，非 svelte 边 **召回 65.9%、精度 74.6%**。
Q3 的 `commit` 解析到真实调用者 `CodeArea.svelte:115`（`handleKeydown`），与 Jelly 完全一致——说明 SFC
内部的「函数定义 / 调用点 / caller 归属」已能端到端走通。剩余缺口主要是结构性的：**46% 的 svelte 缺失
边（183/246）callee 是 `<anon>` 回调**（模板事件、`$derived`/高阶），SCIP 从建模上就不产这种边。

## 度量口径与两个 bug 修正

- 去重键 `<file>:<startLine>`（1-based，SCIP `range[0]+1`）；`syntax_kind==15` = 调用点；
  `callee` = 该 occurrence 的 symbol 定义位置；`caller` = occurrence 自身 `enclosing_range` 起点；
  Jelly call 边 = `fun2fun − requireEdges`；`svelte` 严格用 `endswith(".svelte")`。
- **修正 1（关键）**：`callee-poc.py` 用**全局** `sym_defs[symbol]` 解析 callee，但 scip-typescript 的
  局部符号只发裸名 `local N`、**仅在本文档内有意义**（同一 `local 63` 出现在 20 个文件里）。
  全局解析会把 svelte 内部调用散到别的文件，是 callee-poc 的 bug。本脚本以**文档内解析（scoped，符合
  SCIP 语义）**为 headline，同时保留 **global**（callee-poc 字面口径）用于对照。
- **修正 2**：`SymbolInformation.kind` 也必须按文档取（局部符号同样会跨文件撞名），否则函数节点会被
  误判成 `Constant`/`Variable`，把函数召回压低到 60%。
- Jelly 非 module 非 svelte 函数 **1355 个**，但去重后只有 **1351 个 `file:line` key**（4 对重复的
  `<anon>` 键）；表里分母按任务书用 1355。

## 指标表

| 维度 | SCIP(fork) | Jelly 分母 | 交集 | 召回 | 精度 |
| --- | ---: | ---: | ---: | ---: | ---: |
| 文档总数 | 162 | 162 | — | — | — |
| `.svelte` 文档 | **38** | 38 | 38 | 100% | 100% |
| occurrence 总数 | 40471 | — | — | — | — |
| `syntax_kind==15` | 6341 | — | — | — | — |
| 带 `enclosing_range` 的 occurrence | 39885 | — | — | — | — |
| 函数节点 — 非 svelte | 1048 | 1355 | 785 | 57.9% | 74.9% |
| 函数节点 — `.svelte` | 211 | 367 | 209 | **57.0%** | **99.0%** |
| 调用边 — 非 svelte | 1442 | 1633 | 1076 | 65.9% | 74.6% |
| 调用边 — `.svelte` | 559 | 615 | 369 | **60.0%** | **66.0%** |
| 调用边 — 合计 | 2001 | 2248 | 1445 | 64.3% | 72.2% |

> 对照（callee-poc 字面 global 口径）：svelte 边召回 **27.6%** / 精度 **30.4%**；非 svelte 边召回 **60.0%** /
> 精度 **67.9%**（与 `poc-callee.md` 的 0.6001 / 0.6759 对齐，证明本脚本非 svelte 口径一致）。
> svelte 数字相差一倍，全部来自上面修正 1。函数节点另有宽口径（把 StaticMethod/Getter/Setter/Constructor
> 也算函数）几乎无变化（58.0% / 57.0%）。

## Q3 — `CodeArea.svelte` 的 `commit`

- SCIP 定义节点：`src/lib/components/areas/CodeArea.svelte:86`（kind=Function，与 Jelly `commit` @86 一致）。
- **scoped**：caller = **`src/lib/components/areas/CodeArea.svelte:115`**（即 `handleKeydown`，`commit()` 在 119 行被调用）。
- Jelly：caller 同为 `CodeArea.svelte:115` → **完全一致，端到端可用**。
- global（callee-poc 口径）：**找不到 caller**（因为 `local 63` 被全局分散到别的文件）——进一步佐证修正 1 的必要性。

## `.svelte` 缺失边归因（scoped，缺 246/615）

| 归因 | 条数 | 占比 |
| --- | ---: | ---: |
| callee 是 `<anon>`（回调 / 高阶调用） | **183** | 74% |
| callee 已索引但 caller/归属对不齐 | 38 | 15% |
| 真·未出现在 SCIP 定义里 | 19 | 8% |
| 其它非函数声明（Const/Var 等） | 5 | 2% |
| 接口/类型声明 | 1 | 0.4% |

结论：与 callee-poc 对非 svelte 的归因同构——**回调/高阶调用是最大且原理上不可补的缺口**（Jelly 把
`onclick={() => …}`、`$derived(…)`、`addEventListener(…, cb)` 这类注册也算一条 call 边，SCIP 只认
「标识符当 callee」）。真正「SCIP 完全没索引到」的只有 19 条，说明 Svelte 支持本身没有大片遗漏。

## 复现命令

```bash
# 1) 用 fork 版索引器索引（二进制在 gitignored cache 里；重建见 fork-build.md）
node rules/scip-typescript/dist/src/main.js index \
  --cwd  /home/n/document/code/gpen/gpen-js \
  --output rules/out/.cache/scip/index-fork.scip

# 2) SCIP -> JSON
~/tools/scip/scip print --json rules/out/.cache/scip/index-fork.scip \
  > rules/out/.cache/scip/index-fork.json

# 3) 指标
python3 rules/scip/svelte-poc.py \
  --scip rules/out/.cache/scip/index-fork.json \
  --jelly rules/out/func.json \
  --out  rules/out/scip-svelte-poc.json
```

索引日志无 error，约 2.4 s 完成；产物 `index-fork.scip` 4.7 MB / JSON 9.0 MB。

## 注意事项

- **headline 指标为 scoped**；`edge_metrics_global` 只是为对齐 callee-poc 历史数字而保留，不应作为
  svelte 能力的判断依据（它是工具 bug 的产物）。
- 函数节点召回整体只有 ~58%（非 svelte 亦然），主要不是「漏索引」，而是 **Jelly 与 SCIP 的函数建模差异**：
  Jelly 把箭头函数 / 对象字面量成员 / 回调都算函数，SCIP 给它们 `Property`/`Variable`/`Constant` kind。
  svelte 函数节点精度 99% 说明 fork 识别出的函数几乎都真实存在。
- 6341 个调用 occurrence 中 4145 个 callee 落不到本仓库定义（`String`/`Error`/`Math` 等内建，以及
  `$state()`/`$derived()`/`$effect()` rune），与 Jelly 的可比口径无关，属预期。
- fork 工作树是 gpen-js 的 `rules/scip-typescript` 子模块（HEAD `e42e263`，分支 `gpen`）；若被清掉需按
  `fork-build.md` 重建。
- 本报告数字均为本次实测；`1884` 函数 / `162` moduleNodes / `2248` 边 / `367` svelte 函数 / `615` svelte
  边等 Jelly 侧数字从 `func.json` 现读，与任务书给的已知值一致。
