# scip-graph（净室重构）

SCIP 派生的 call graph 浏览器：GUI-HTML + TUI 双面、可 `git/jj diff`、预留 mermaid/graphviz 兼容。

**设计与决策见 [`docs/PLAN.md`](docs/PLAN.md)（唯一权威）。**

## 来源 / 归档

这是 **净室重写**，与旧实现无 git 血缘。

- 旧实现归档：分支 `deprecated-202609`、tag `legacy-202609`，旧 `main` SHA `4483ebc9e3280ff38eaa6789124dccf7f247fdd6`。
- 需要查旧实现时 `git checkout deprecated-202609`；日常不要读它，避免污染新代码上下文。

## 状态

`M1` 骨架：IR 类型（`src/lib/ir/types.ts`）+ mock（`src/lib/ir/mock.ts`）。后续里程碑见 `docs/PLAN.md` §6。
