# Track D — scip-typescript PoC（gpen-js 符号级 def/ref + 跨 repo）

> 迁移说明：本文档原在 gpen-js `rules/scip/README.md`，记录历史 PoC；其中的 `.py` 分析脚本
> 留在 gpen-js，不在本仓库。

> 控制组是 gpen-js 的 Jelly 基线 `rules/README.md`（`rules/out/func*.json`），
> 以及已完成的 Track A/B（Joern / CodeQL，**其环境已按选型结论用 `trash` 移除**，
> 报告见 `rules/out/callgraph-tooling-comparison.md` 与 git 历史）。
> 该目录只服务 PoC，**不接进 `package.json`**，也不替换 Jelly 基线。

## 一句话结论

**scip-typescript 值得作为 Jelly 的「符号索引」补充引入（Apache-2.0、26 MB 包体、3 秒索引、
产物字节幂等），但不做调用图、也依然看不见 `.svelte` 组件。** 它补上的是 Jelly/CodeQL
都没有的 **符号级 def/ref（含非调用的类型引用/import）** 与 **`file:` 跨 repo 的符号级链接**
（实测 `gpen-js → gpen-protocol` 116/116 个协议符号全部 join 上定义），成本比 Joern/CodeQL
低两个数量级；代价是 SFC（38 个组件、约占 Jelly 函数 21.3%）依然是盲区。

## TL;DR

| #   | 问题                      | 结论                                                                                                                                               |
| --- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | 覆盖率 / `.svelte`？      | 124 文档（**全部 `.ts`**，含 7 `.d.ts` + 5 `*.svelte.ts`）；**`.svelte` SFC = 0**，且 SFC 默认导入塌缩成 Svelte 的 `*.svelte` 环境模块 `Comp` 符号 |
| S2  | 符号级 def/ref？          | ✅ 定义位置 + **全部引用**（含 import、类型注解、跨 node_modules 符号）；`createEditHistory` def `history.ts:139`，2 引用（1 import + 1 call）     |
| S3  | 4 个同名 `commit` 消歧？  | ✅ TS 侧按全限定符号消歧（3 个 `commit` 符号：2 接口 + 1 实现，不 ambiguous）；❌ 两个 `.svelte` 的 `commit` 不存在                                |
| S4  | 跨 repo（`file:` 依赖）？ | ✅ **116/116** 个 `gpen-protocol` 符号都能 join 到 `../gpen-protocol` 独立索引里的定义（`Gpen#` → `gpen/v1/gpen.ts:18`）                           |
| S5  | 成本 / 幂等 / license？   | 3.15 s / 378 MB RSS；`.scip` 3.39 MB、JSON 5.83 MB、SQLite 3.52 MB；两次运行**字节相同**；Apache-2.0；无网络                                       |
| S6  | 与 Jelly 互补？           | ✅ 互补：Jelly=调用图（含 SFC），scip=符号/类型引用 + 跨 repo；**不能替换**，只补 TS 侧符号导航                                                    |

## 1. 安装与版本（S5）

```bash
bun i -g @sourcegraph/scip-typescript          # 0.4.0, Apache-2.0, 1.4 MB

# scip CLI（读/转换 .scip；Go 二进制，Apache-2.0）
mkdir -p ~/tools/scip && cd ~/tools/scip
curl -fLO https://github.com/scip-code/scip/releases/download/v0.10.0/scip-linux-amd64.tar.gz
tar -xzf scip-linux-amd64.tar.gz                # -> ~/tools/scip/scip (26 MB)
~/tools/scip/scip --version                     # scip version v0.10.0
```

| 项                | 值                                                                                                             |
| ----------------- | -------------------------------------------------------------------------------------------------------------- |
| `scip-typescript` | 0.4.0，Apache-2.0，1.4 MB（依赖 `commander`/`google-protobuf`/`progress`/**`typescript@5.9.3`**，合计 ~26 MB） |
| `scip` CLI        | v0.10.0，Apache-2.0，26 MB 单文件二进制                                                                        |
| 合计新增磁盘      | **~52 MB**（对比 Joern 2.1 GB + JDK 346 MB、CodeQL ~1 GB）                                                     |
| 内网/离线         | 装好后全离线；无 JDK、无服务端                                                                                 |

> 注意：scip-typescript 自带 **TypeScript 5.9.3**（其 `package.json` 依赖 `^5.6.2`），
> 不是本仓库 devDependency 的 `typescript@6.0.3`。gpen 语法在 5.9 下能解析，但版本错位是长期风险。

## 2. 运行（S1/S2/S3）

```bash
cd /home/n/document/code/gpen/gpen-js
scip-typescript index --output rules/out/.cache/scip/index.scip
~/tools/scip/scip print --json rules/out/.cache/scip/index.scip > rules/out/.cache/scip/index.json
python3 rules/scip/analyze.py        # -> rules/out/scip-symbols.json
```

`scip-typescript` 直接读仓库 `tsconfig.json`（`extends "$app/tsconfig"`、`include: ["src"]`），
`.svelte-kit` 已 sync，`#lib/*` / `$app/*` 别名都通过 TS program 正常解析，**无需 `--infer-tsconfig`**。

**索引日志（无 warning、无 error）**：

```
.
+ /home/n/document/code/gpen/gpen-js (1s 583ms)
done /home/n/document/code/gpen/gpen-js/rules/out/.cache/scip/index.scip
```

### S1 — 覆盖与 `.svelte` 证据

```
documents: 124
extensions: {'ts': 124}
.svelte documents: 0
```

- 仓库 `src/` 实际有 **124 `.ts`**（含 7 个 `.d.ts`、5 个 `*.svelte.ts` runes 模块）、
  **38 `.svelte`**、6 `.js`。scip 收了全部 `.ts`。
- 5 个 `*.svelte.ts` runes 模块（`gpenDocumentSession.svelte.ts` 等）**被索引**——这是
  Svelte 5 把逻辑放进 `.ts` 带来的部分红利。
- **38 个 `.svelte` SFC 一个都没进**（`scip-typescript` 走 TS program，不认 SFC）。

**双重证据**：

1. `scip print --json` 里 `relative_path` 以 `.svelte` 结尾的文档数 = 0；
2. `.svelte` 的**默认导入被塌缩**成 Svelte 类型垫片的通用符号。例如
   `src/embed/index.ts:15` `import GpenOverlay from "#lib/components/GpenOverlay.svelte"`
   （0-based 行 14）：

   ```
   [14,7,18]  scip-typescript npm svelte 5.56.8 types/`index.d.ts`/`'*.svelte'`/Comp.
   [14,7,18]  scip-typescript npm svelte 5.56.8 types/`index.d.ts`/`'*.svelte'`/Comp#
   ```

   即所有 SFC 组件的默认导出都指向同一个环境模块 `declare module '*.svelte' { const Comp: Component }`
   的 `Comp`，**没有按文件的符号身份**（`GpenOverlay.svelte` / `ContextMenu.svelte` 无法区分）。

这比 Joern/CodeQL 的「skip」更细致地说明了根因：不是扩展名过滤，而是 TS 语言服务本就
没有 SFC 语义。对照 Jelly fork：`.svelte` 里 367 个函数（1722 的 **21.3%**）、
2248 条 call 边里 615 条（**27.4%**）有一端在 SFC —— 这些 scip 也拿不到。

### S2 — 符号级 def/ref（含非调用引用）

`createEditHistory`（`src/lib/history.ts`）：

```
SYM scip-typescript npm gpen-js 0.0.3 src/lib/`history.ts`/createEditHistory().
  defs (1):
    src/lib/history.ts:138:16          # 1-based 行 139
  refs (2):
    src/lib/components/gpenDocumentSession.svelte.ts:32:9    roles=0   # import（非调用）
    src/lib/components/gpenDocumentSession.svelte.ts:167:12  roles=0   # 调用点
```

**能给出「定义 + 全部引用」，且引用区分角色**：`roles=0` 为普通引用，SCIP 的 `symbol_roles`
位标志另有 Definition/Import/Write/Read/Generated/Test/Forward（本索引里 `scip-typescript`
对多数引用只写 0，写访问/读访问位不总置位，所以「读/写」不能当稳定依据）。

类型引用（非调用）同样可导出 —— 例如跨文件的类类型：

```
SYM .../protocol/`codec.ts`/GpenCodecError#
  defs: src/lib/protocol/codec.ts:31:13
  refs: codec.ts:{54,72,84,97}  +  storage/objects/gpenBinary.ts:{15,278,383}
```

这是 **Jelly 不做**（只有调用点）、**CodeQL 调用图也不直接给**的能力：它覆盖
import、类型注解、泛型实参、装饰器等所有符号出现位置，甚至能指到 `node_modules`
（如 `typescript 5.9.3 lib/lib.es5.d.ts/Uint8Array#`）和 `svelte` 类型垫片。
全量符号表在 `rules/out/.cache/scip/symbols-full.json`（4799 个有定义的符号）；
`rules/out/scip-symbols.json` 是目标符号的轻量切片。

### S3 — 4 个同名 `commit` 的消歧

| 任务书的 `commit`                                          | SCIP 结果                                                                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/history.ts:152`（1-based）                        | ✅ 归入 `.../history.ts/EditHistory#commit().`：接口定义在 `history.ts:59`（1-based 60），**实现处 `:151`（1-based 152）是一条 ref**，另有调用 `gpenDocumentSession.svelte.ts:194` |
| `src/lib/bindings/storage/objects/gpenBinary.ts:462`       | ✅ `.../gpenBinary.ts/GpenBinaryRuntime#commit().`，def `:461`（1-based 462），refs `:424`、`:478`                                                                                 |
| `src/lib/components/areas/CodeArea.svelte:86`              | ❌ **不存在**（SFC 未索引）                                                                                                                                                        |
| `src/lib/components/widgets/inputs/InputNumber.svelte:189` | ❌ **不存在**（SFC 未索引）                                                                                                                                                        |

补充：TS 侧 `commit` 其实有 **3 个符号**（比 Jelly 的 2 个 TS 函数多一个），因为
`gpenBinary.ts` 同时有接口声明 `GpenBinaryStore#commit()`（def `:127`）与类实现
`GpenBinaryRuntime#commit()`；接口与实现在 scip 里是**两个符号**，靠 `implementations`
关系相连（scip-typescript 会把实现方法的出现记成接口符号的引用）。

**消歧方式**：全限定 SCIP 符号（`package version path/descriptor`）唯一，查询任一
`commit` 不会静默取第一个、也不会像 Jelly 那样报 `ambiguous` —— 但对**跨模块接口调用**，
调用点会落到接口符号（与 CodeQL 行为一致），要继续追实现需要额外读 `implementations` 关系。

## 3. 跨 repo（S4）

scip-typescript 的符号串自带 `package + version + 文件路径`，天然可跨索引 join。
把 `gpen-protocol` 单独索引（该仓库**没有 tsconfig**，需 `--infer-tsconfig`）：

```bash
cd ../gpen-protocol
scip-typescript index --infer-tsconfig generated \
  --output /home/n/document/code/gpen/gpen-js/rules/out/.cache/scip/gpen-protocol.scip
/home/n/document/code/gpen/gpen-js/rules/scip/cross-repo.py   # -> rules/out/scip-crossrepo.json
```

结果：

```
gpen-js 引用的 gpen-protocol 符号: 116
其中能在 gpen-protocol 索引里找到定义: 116   (未 join 上: 0)
```

`src/lib/protocol/codec.ts` 的具体链路：

| gpen-js 引用的符号                                      | gpen-protocol 里的定义（1-based）              |
| ------------------------------------------------------- | ---------------------------------------------- |
| `.../gpen.ts/Gpen#`                                     | `generated/flatbuffers/gpen/v1/gpen.ts:18:13`  |
| `.../gpen.ts/GpenT#`                                    | `generated/flatbuffers/gpen/v1/gpen.ts:297:13` |
| `.../gpen.ts/Gpen#getRootAsGpen().`                     | `.../gpen.ts:27:7`                             |
| `.../gpen.ts/Gpen#finishGpenBuffer().`                  | `.../gpen.ts:256:7`                            |
| `.../gpen.ts/GpenT#pack().`                             | `.../gpen.ts:313:0`                            |
| `.../toolbar-state.ts/ToolbarState#` / `ToolbarStateT#` | `.../toolbar-state.ts:15:13` / `:226:13`       |

**这是 Joern/CodeQL 都做不到的真跨 repo 链接**：Joern 只连到 `filename=<empty>` 的合成 stub，
CodeQL 里 `node_modules` 抽取 0 文件、codec.ts 22 个调用全部 unresolved；Jelly 因
`--ignore-dependencies` 故意断开（边界 `D`）。scip 的 join 纯符号串匹配，不需要把
provider 源码塞进 consumer 索引，也不执行构建。

> 前提：**provider 要单独建一次索引**（两仓库各一次）。`file:` 依赖在
> `node_modules/gpen-protocol` 是软链接到 `../gpen-protocol`，所以也可以
> `scip-typescript index` + 一个「多索引 merge」脚本常驻，但 scip CLI v0.10.0 没有 merge 子命令，
> 需要自己按 symbol 串拼。

## 4. 成本 / 幂等 / 产物（S5）

| 指标                           | gpen-js                                            | gpen-protocol                    |
| ------------------------------ | -------------------------------------------------- | -------------------------------- |
| 墙钟                           | **3.15 s**（user 6.25 s，210% CPU）                | 1.61 s                           |
| 峰值 RSS（`/usr/bin/time -v`） | **378 MB**                                         | 227 MB                           |
| 文档                           | 124                                                | 87                               |
| occurrence                     | 30144                                              | 21160                            |
| 定义                           | 6723（4799 个符号）                                | 4800                             |
| `.scip`                        | `rules/out/.cache/scip/index.scip` **3,394,617 B** | `gpen-protocol.scip` 2,933,796 B |
| `scip print --json`            | `index.json` 5,830,190 B                           | 4,655,808 B                      |

产物格式与可读性：

- `.scip` 是 SCIP protobuf（Google protobuf），`scip print --json` 转 JSON，
  `scip expt-convert` 转 **SQLite**（v0.10.0 实测 5 张表：`documents` / `global_symbols` /
  `mentions` / `chunks` / `defn_enclosing_ranges`，0.2 s 出 3.52 MB `.db`）。
  v0.10.0 已**没有** LSIF `convert` 子命令，只有 `expt-convert`。
- **幂等**：同源码连跑两次，`index.scip` SHA-256 相同、`print --json` 输出也字节相同
  （`f693d20…` / `9bc5b34…`，均两次一致）。可以直接做可 diff 基线。
- **跨机器注意**：JSON/SCIP 的 `metadata.project_root` 是绝对路径
  （`file:///home/n/document/code/gpen/gpen-js`），换机器/换 clone 会漂。要当提交基线需像
  Jelly 那样归一化这两处；同机同日是稳定的。
- 查询侧完全离线；无服务端、无 license 服务。

错误原文（唯一的失败点，在 provider 侧）：

```
$ cd ../gpen-protocol && scip-typescript index generated
- /home/n/document/code/gpen/gpen-protocol (missing tsconfig.json)
error: no files got indexed. ...
```

加 `--infer-tsconfig` 后正常。gpen-js 侧没有任何 warning/error。

## 5. 与 Jelly 的互补性（S6）

| 能力                          | Jelly（基线）                      | scip-typescript                    | 互补性                           |
| ----------------------------- | ---------------------------------- | ---------------------------------- | -------------------------------- |
| 函数级调用图                  | ✅ 2248 边（含 SFC）               | ❌ 无调用图概念                    | Jelly 不可替代                   |
| `.svelte` `<script>`          | ✅ fork 掩码支持（367 函数）       | ❌ 0 文档，SFC 导入塌缩成 `Comp`   | Jelly 胜                         |
| 未解析边界分类                | ✅ A/B/C1/C2/D/I/U/9               | ❌                                 | Jelly 胜                         |
| def/ref（含类型/import 引用） | ❌ 只有调用点                      | ✅ 符号级、全仓库                  | **scip 差异化**                  |
| 同名符号消歧                  | 报 `ambiguous` 列候选              | ✅ 全限定符号                      | scip 更细（但接口/实现要自己追） |
| 跨 repo 引用                  | ❌（故意 `--ignore-dependencies`） | ✅ 116/116 join 到 `gpen-protocol` | **scip 差异化**                  |
| 数据流/污点                   | ❌                                 | ❌                                 | 都不行（CodeQL 才补）            |
| 产物幂等                      | ✅ 归一化后                        | ✅ 原生产物即幂等                  | 平                               |
| 成本                          | 已入库、秒级                       | 26 MB 包 + 3 s 索引 + 3.4 MB 索引  | scip 很轻                        |

**结论**：scip 适合补 Jelly 的两个洞 —— 「精确符号导航（类型/import 引用）」和
「`gpen-js → gpen-protocol` 跨 repo 引用」。它**不**产出调用图，所以不能替换 Jelly；
它的 SFC 盲区与 Joern/CodeQL 相同，所以也不能拿它回答「CodeArea.svelte 的 commit 谁调」。

## 6. 桌面调研（只读，未安装）

| 工具                         | 解析 `.svelte`                 | 函数级                     | 跨 repo                                                 | 数据流                                | License                                                                                                | 状态                                                                                  | 对 gpen 的结论                                                                                   |
| ---------------------------- | ------------------------------ | -------------------------- | ------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Sourcetrail**              | ❌                             | ✅ 类/函数级               | ❌（单 project）                                        | ❌                                    | GPL-3.0                                                                                                | **已归档 2021-12-13**（16.5k★）                                                       | 不引入：停更 4 年、无 SFC、GUI 单机                                                              |
| **Sourcegraph**              | ❌（无 SFC 提取器）            | ✅ SCIP/LSIF 符号          | ✅（面向多 repo code host）                             | ❌                                    | 核心 Apache-2.0 + **企业版专有**；主仓已转私有，公开快照 `sourcegraph-public-snapshot` 于 2024-09 归档 | 在售/私有                                                                             | 不引入：部署重（需 code host + 服务端），单机项目用 `scip` 本地索引即可                          |
| **Understand**（SciTools）   | ❌（无 SFC；Web 语言支持有限） | ✅ 函数/依赖图             | ⚠️ 多项目手工配                                         | ❌（有 CodeCheck 规则，无污点数据流） | 商业专有                                                                                               | 在售                                                                                  | 不引入：采购成本 + 无 SFC + 无跨 repo 自动链                                                     |
| **tree-sitter-stack-graphs** | ❌                             | ✅ def/ref（**非调用图**） | ✅ **设计目标就是跨 repo 名字解析**（增量、不依赖构建） | ❌                                    | Apache-2.0                                                                                             | `github/stack-graphs` **归档 2025-09**（875★）；有 JS/TS 语言规则，v0.10.0（2024-12） | 不引入（现成版停更）；若将来自研索引，其「跨 repo 名字解析」思路与 scip 重叠，可直接用 scip 省事 |
| **madge**                    | ❌                             | ❌（模块级依赖图）         | ❌                                                      | ❌                                    | MIT                                                                                                    | 活跃（2026-01）                                                                       | 不引入：模块级依赖图已由 scip 的符号/引用（file 级扇入扇出）覆盖                                 |

> 事实核验：Sourcetrail / madge / sourcegraph-public-snapshot / github/stack-graphs 的
> license、归档状态、最后 push 均来自 GitHub API（2026-09 查询）。Understand 为官网商业产品，
> 具体语言矩阵未逐条核验，按「商业专有、不支持 Svelte SFC」记录。

## 7. 复现

```bash
bash rules/scip/run.sh        # 装好 scip-typescript + ~/tools/scip/scip 后一键复跑
```

产物：

| 路径                                                 | 内容                                                                        | 入库    |
| ---------------------------------------------------- | --------------------------------------------------------------------------- | ------- |
| `rules/scip/run.sh` / `analyze.py` / `cross-repo.py` | 复现脚本与解析器                                                            | ✅      |
| `rules/out/scip-symbols.json`                        | S1 统计 + S2/S3 目标符号 def/ref（4.7 KB）                                  | ✅      |
| `rules/out/scip-crossrepo.json`                      | S4 116 个符号的 consumer↔provider 链接表（44 KB）                           | ✅      |
| `rules/out/.cache/scip/index.scip` 等                | 原始索引（3.4 MB+）、JSON（5.8 MB+）、SQLite、`symbols-full.json`（3.3 MB） | ❌ 缓存 |

> 与 Track B 相同的集成阻塞点：根 `.gitignore` 采用「白名单取反」，`rules/out/` 默认全忽略，
> 因此 `rules/out/scip-*.json` 需 Track E 追加 `!rules/out/scip-*.json` 才会被跟踪。
> 这不在 Track D 的写入范围，此处只记录。

## 8. 建议

1. **引入形式**：作为 Jelly 的**按需补充**（不常驻 CI）——回答「这个符号还有哪些引用 /
   这个 `gpen-protocol` 类型来自哪个生成文件」时跑一次 `scip-typescript index`（3 s）。
2. **不要**用 scip 做调用图基线：它没有 call 边，且同样丢失 38 个 SFC。
3. 若引入，把 `rules/out/scip-symbols.json` + `scip-crossrepo.json` 作为轻量基线提交，
   原始 `.scip` 留在 `.cache`；跨机器前先归一化 `metadata.project_root`。
4. 关注 scip-typescript 的 TS 版本（自带 5.9.3）与本仓库 TS 6.0.3 的错位。
