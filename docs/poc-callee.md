# Track F — 给 scip-typescript 打补丁导出调用图（callee）

> 迁移说明：本文档原在 gpen-js `rules/scip/README-callee-poc.md`，记录历史 PoC；
> 其中的 `.py` 指标脚本留在 gpen-js，不在本仓库。

> 背景见 [`scip-index-poc.md`](scip-index-poc.md)（Track D）与 gpen-js 的
> `rules/out/callgraph-tooling-comparison.md`（Track E）。
> 本文件只记录 **callee PoC**：给 `scip-typescript` 0.4.0 打最小补丁，
> 让它输出 SCIP 规范里已有、但上游从不发的调用图字段，然后用 **同一口径** 与 Jelly 基线比召回/精度。

## 一句话结论

**补丁可行且有效：调用边召回 43.4% → 60.0%，精度 39.9% → 67.6%（原始口径），
把「调用点被解析成接口/声明而非实现」的 callee 归属偏差剥离后精度 94.9%。**
但 **不能完整替代 Jelly 的 callee 能力**：Jelly 有一类 scip 原理上不产出的边
（回调注册/高阶调用，占缺失边的 52%），加上 `.svelte` / `.js` 盲区与接口→实现消歧，
是当前召回上不去的三个硬边界。

## 1. 补丁做了什么

上游事实：SCIP proto 已有 `Occurrence.syntax_kind`（`IdentifierFunction = 15`，意为“函数引用，包含调用”）
与 `Occurrence.enclosing_range`（spec 明说用于 call hierarchy），但 **scip-typescript 0.4.0
一个 `syntax_kind` 都不发，`enclosing_range` 只在约 1.2k 个定义上发、引用完全不发**。

补丁只动一个文件 `src/FileIndexer.ts`（+66/−1 行，见 gpen-js 的 `rules/scip/scip-typescript-callee.patch`），
共 4 处**最小必要改动**：

1. **调用点打标**：新增 `callSyntaxKind(node)`。当标识符/私有标识符是
   `CallExpression` / `NewExpression` 的 callee（含 `foo()`、`obj.foo()`、`foo?.()`、`new Foo()`）时，
   在 occurrence 上写 `syntax_kind: SyntaxKind.IdentifierFunction`（=15）。
2. **引用补 `enclosing_range`**：新增 `enclosingFunctionRange(node)`，对每个 occurrence
   取**最近的** `function / method / arrow / constructor / accessor / **class**` 祖先节点作为 `enclosing_range`；
   模块级回落到整文件（起点固定第 0 行，使 caller key = `<file>:1`，对齐 Jelly 的 module node）。
   `class` 必须算 scope：Jelly 把类体（字段初始化器等）的调用归给类节点，
   例如 Q1 的 `createEditHistory<GpenT>(...)` 是 `DocumentSessionCore` 的字段初始化器。
3. **定义侧顺带补齐**：把 `PropertyAssignment` / `PropertyDeclaration`（`{ canUndo: () => … }`、
   `f = () => {}`）也纳入「用函数初始化器作为 enclosing range」的既有分支。
   引用侧凡是没有 enclosing range 的，一律走第 2 步兜底。
4. 补丁**不新造符号、不改 emit 结构**；`pushOccurrence` 的去重（只比 `range/symbol/symbol_roles`）
   不受新字段影响，产物体积 3.39 MB → 3.62 MB（+6.6%）。

`git diff` 落在 Track F clone commit `e22988d9a80a5cfaa5ad3afbfbc99bab511fd24a`
（`sourcegraph/scip-typescript` main，版本 0.4.0）。

### 构建 / 运行

> 一键构建：`bash rules/scip/build-patched.sh`（clone + checkout pin commit + 幂等重打补丁 + `tsc -b`）。下面是等价的手工步骤。

```bash
cd rules/out/.cache/scip-ts
git clone --depth=1 https://github.com/sourcegraph/scip-typescript .   # 首次
git apply /home/n/document/code/gpen/gpen-js/rules/scip/scip-typescript-callee.patch

# 包管理器是 yarn@1.22，本机没有 yarn -> 用 bun 装依赖（只 prepare 的 snapshots 子装失败，无关）
bun install || true
node_modules/.bin/tsc -b .                       # 产物 dist/src/main.js

# 用补丁版索引 gpen-js（cwd = 仓库根，走仓库 tsconfig.json，只含 src/）
cd /home/n/document/code/gpen/gpen-js
node rules/out/.cache/scip-ts/dist/src/main.js index \
  --cwd  /home/n/document/code/gpen/gpen-js \
  --output rules/out/.cache/scip-ts/index-patched.scip
~/tools/scip/scip print --json rules/out/.cache/scip-ts/index-patched.scip \
  > rules/out/.cache/scip-ts/index-patched.json

# 指标（before = 未打补丁的 rules/out/.cache/scip/index.json）
python3 rules/scip/callee-poc.py \
  --before rules/out/.cache/scip/index.json \
  --after  rules/out/.cache/scip-ts/index-patched.json \
  --repo . \
  --out   rules/out/scip-callee-poc.json \
  --graph rules/out/scip-callgraph.json
```

索引日志无 warning/error，1.6 s 完成（与原版 1.58 s 同量级）。
补丁后：occurrence 30472，其中 `syntax_kind=15` **4219**，带 `enclosing_range` **30115**（补丁前 1253）。

## 2. 度量口径

- 去重键 `<file>:<startLine>`（1-based；SCIP 用定义 occurrence `range[0]+1`，与 Jelly `functions` 的 startLine 对齐）。
- Jelly call 边 = `fun2fun − requireEdges`；非 svelte = 两端文件都**不以 `.svelte` 结尾**（`endswith`，不用 `includes`，避免误伤 `.svelte.ts`）。
- **before**：调用判定 = 文本启发式（标识符后接 `<…>(` / `(` / `?` / `!`）；caller = 包含调用点的最内层 definition 的 `enclosing_range`；callee = 调用 occurrence 的 symbol 的定义位置。
- **after**：调用判定 = `syntax_kind === 15`；caller = 调用 occurrence 自身的 `enclosing_range` 起点；callee 同上。
- 所有指标分母/交集都以 Jelly 的 `(file,line)->(file,line)` 边为准。

## 3. 补丁前 vs 补丁后

Jelly 基线：2248 条 call 边，其中**非 svelte 1633 条**。

| 指标 (vs Jelly 非 svelte) | before（文本启发式） | after（补丁） | 变化 |
| --- | ---: | ---: | ---: |
| 调用 occurrence 识别数 | 4855 | 4219 | −13%（去掉启发式误报） |
| 预测边数（唯一） | 1779 | 1450 | −18% |
| 交集边 | 709 | 980 | **+38%** |
| **精度** | **39.9%** | **67.6%** | **+27.7 pt** |
| **召回** | **43.4%** | **60.0%** | **+16.6 pt** |
| 精度（仅统计两端都落到 Jelly 函数节点的边） | 67.1% | **94.9%** | +27.8 pt |
| 召回（vs Jelly 全部 2248 边，含 svelte） | 31.5% | 43.6% | +12.1 pt |

> before 的召回 43.4% 与任务书给的 42.9% 基本一致；精度 39.9% 与任务书的 52.9% 不同，
> 差异来自「预测边」的定义——本脚本把 `callee symbol 的任意定义`都算一条预测边
> （包括解析到接口/类型声明的边，因此 precision 更低、更严格）。把预测边收紧到
> 「两端都是 Jelly 函数节点」后 before=67.1%。两种口径 before/after 都是显著提升。

**补丁确实生效**：before 的调用判定用文本启发式（含大量 `String(…)`、`Error(…)`、
`Math.max(…)` 等内建误报，4855 次命中里 2698 次 callee 无法落到本仓库定义）；
after 用 `syntax_kind` 后命中降到 4219、误报减少，交集反而从 709 涨到 980。

## 4. 补齐目标（Q1 / Q2 / Q5）

### Q1 — `createEditHistory` 的调用者

补丁后索引：

```
SYM .../`history.ts`/createEditHistory().
  def  src/lib/history.ts:139
  ref  src/lib/components/gpenDocumentSession.svelte.ts:33   (import，syntax_kind=0)
  call src/lib/components/gpenDocumentSession.svelte.ts:168  (syntax_kind=15, enclosing=[164,0,215,1])
```

调用点 line 168，`enclosing_range` 起点 0-based 164 → **caller = `gpenDocumentSession.svelte.ts:165`
（`class DocumentSessionCore`）**，与预期（Jelly `DocumentSessionCore:165`）**一致**。
这是补丁把 `class` 当 enclosing scope 的关键收益：上游原本会回落到整文件，指不到类。

### Q2 — 同名 `commit` 消歧

补丁后 TS 侧共 **3 个** `commit` 符号（Jelly 只有 2 个 TS 函数）：

| # | SCIP 符号（全限定） | def (1-based) | 调用点（syntax_kind=15） |
| - | --- | --- | --- |
| 1 | `history.ts/EditHistory#commit().` | `history.ts:60`（接口） | `gpenDocumentSession.svelte.ts:195`（caller@193） |
| 2 | `gpenBinary.ts/GpenBinaryRuntime#commit().` | `gpenBinary.ts:462`（类实现） | `gpenBinary.ts:425`、`:479` |
| 3 | `gpenBinary.ts/GpenBinaryStore#commit().` | `gpenBinary.ts:128`（接口） | `gpenDocumentSession.svelte.ts:307/368/486/524` |

- 全限定符号天然区分同名，**不 ambiguous**；`history.ts:152`（对象字面量实现）在 SCIP 里是一条 **ref**（实现接口），不是定义。
- ⚠️ 但**跨接口调用点会落到接口符号**：`gpenDocumentSession.svelte.ts` 里 4 次 `store.commit()` 解析到
  `GpenBinaryStore#commit()`（`gpenBinary.ts:128` 接口声明），而 Jelly 把它们归给实现 `GpenBinaryRuntime#commit()`（`:462`）。
  这正是 §5 里精度/召回损失的主因之一。两个 `.svelte` 的 `commit` 依旧不存在（SFC 盲区）。

### Q5 — `addEventListener` 回调

补丁后索引里有 **47** 个 `addEventListener` 调用 occurrence（`syntax_kind=15`），
但它的**回调参数没有、也不会有** call 边：`addEventListener("x", cb)` 里 `cb` 是实参不是 callee，
SCIP/TS 语言服务不做「回调注册 = 调用」的语义。**预期仍然无**——与 Jelly 的边界 `A`、CodeQL/Joern 一致。

## 5. 失败点与召回上限

补丁后相对 Jelly 非 svelte 1633 条边，**漏了 656 条**。逐条归因（互斥）：

| 缺失原因 | 条数 | 说明 |
| --- | ---: | --- |
| callee 是 `<anon>`（回调/高阶调用） | **344**（52%） | Jelly 把「函数把回调注册进去 / 高阶调用」也记成一条 call 边，callee 指向匿名箭头；scip 的调用边只认「标识符当 callee」，原理上产不出。**这是最大且不可补的缺口。** |
| 接口/重载解析歧义 | 114 | 调用点解析成接口声明而非具体实现（见 Q2），callee 的 `(file,line)` 与 Jelly 不一致。 |
| `.js` 目标 | ~106 | `scip-typescript` 只索引 tsconfig 的 `.ts`：`src/lib/paraglide/*.js`（7 个文件）完全没进索引。 |
| caller 对不齐 | 20 | 同一 callee 已在预测集，但 caller 行号与 Jelly 不同（嵌套箭头/立即执行等）。 |
| 其它 | ~175 | 少量模块级/属性访问/构造函数等归属差异。 |

同时 **精度损失 473 条误报**：其中 **413 条的 callee 根本不在 Jelly 函数集合里**
（解析到接口方法/类型声明 `KvStorage#typeLiteral58:submit()`、`BlobBackend#get()` 等），
53 条两端都是 Jelly 函数但配错。也就是说：**原始精度 67.6% 主要被「接口调用被算成对接口声明的调用」拉低**，
把这些边按 Jelly 的节点口径过滤后精度 94.9%。

无法靠本补丁解决的边界（与 Track D/E 一致）：

- **38 个 `.svelte` SFC** 仍是 0 文档；`.svelte` 内函数/边（Jelly 占 27.4%）全部缺失。
- **7 个 `.js`** 未索引。
- **接口 → 实现消歧**需要额外做「实现关系」解析（上游只对少数内部实现发了 `is_implementation`，
  本索引仅 44 条），补丁没有做。
- **回调/高阶调用**不是「标识符 callee」，SCIP 语义上不建模。

## 6. 结论：scip + 补丁能否替代 Jelly 的 callee？

**部分能，不能完全替代。**

- ✅ 补丁是**低风险、可复现**的最小改动（单文件 +66 行，产物 +6.6%），
  直接把 scip 从「无调用图」变成「有调用图」，精度 39.9%→67.6%、召回 43.4%→60.0%，
  callee 归属口径下精度 94.9%。
- ✅ 它能对齐 Jelly 的「普通具名/方法/构造调用」并保留 SCIP 的差异化能力（全限定符号消歧、跨 repo）。
- ❌ 仍达不到「替代 Jelly」：`.svelte`（27% 边）与 `.js` 盲区、回调/高阶调用建模、
  接口→实现消歧三项合计解释了几乎全部缺口；这些是 SCIP/TS 语言服务的结构限制，不是补丁大小问题。
- 建议定位不变：**Jelly 继续做调用图基线（唯一覆盖 SFC）；scip+补丁作为 TS 侧的补充索引**
  （需要「符号级 call site + caller 函数」时跑一次，3 s 级）。

## 7. 产物

| 路径 | 内容 |
| --- | --- |
| `rules/scip/scip-typescript-callee.patch` | 补丁（`git diff`，+66/−1） |
| `rules/scip/callee-poc.py` | 指标脚本（before/after 同口径） |
| `rules/out/scip-callee-poc.json` | 指标：before/after 的边数 / 召回 / 精度 |
| `rules/out/scip-callgraph.json` | 补丁后导出的调用图：1321 nodes / 1450 edges |
| `rules/out/.cache/scip-ts/` | clone、`dist/`、`index-patched.scip`（3.6 MB）、`index-patched.json`（6.9 MB） |
