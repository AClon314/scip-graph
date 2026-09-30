# Refactor ablation — `refactor/u5`

Evidence-based cleanup + modularisation of the global view. **No behaviour
changes**: the graph schema, `scripts/derive-graph.ts` output and the query
CLI output are untouched, and the documented `window.__global` /
`window.__local` surfaces are preserved (only additions were made).

Method per candidate: (1) find it with a static reference scan
(`rg`, plus a script that counts word-boundary references outside the defining
file); (2) disable/remove it in the working tree; (3) run `bun run check`,
`bun test` and (for UI-visible candidates) the app checklist. For merges, prove
equivalence by re-running the offline precompute and diffing the produced
positions.

## Ablation table

| # | Candidate | Why suspected | How tested | Observed effect | Verdict |
|---|-----------|---------------|------------|-----------------|---------|
| 1 | `collectSymbolIds` (`src/lib/graph/outline.ts`) | zero references in `src/`, `scripts/`, `test/`, `docs/` | removed; `check` + `test` | none | **remove** |
| 2 | `firstSymbolId` (`src/lib/graph/outline.ts`) | zero references | removed; `check` + `test` | none | **remove** |
| 3 | `FOCUS_EVENT` (`src/lib/local/jump.ts`) | zero references; the listener uses the literal `'scip-graph:focus'` | removed; `check` + `test` | none | **remove** |
| 4 | `src/lib/components/GraphSummary.svelte` | no import/render anywhere (placeholder from the pre-canvas phase) | deleted file; `check` + `test` + `build` | none | **remove** |
| 5 | `renderer.debugBoxes` / `geometry` / `zoomTo` / `getZoom` (`src/lib/local/render.ts`) | zero references; only `debugHopCount` is documented for `window.__local.renderer` | removed; `check` + `test` + Local smoke | none | **remove** |
| 6 | `metrics.nodeOverlapPairs` / `bbox` / `unionArea` vs `rect-separation.countOverlaps` / `bboxOf` / `unionArea` | three byte-identical algorithms in two modules | `metrics.ts` now delegates to `rect-separation.ts`; `check` + `test`; re-ran `precompute:force` → positions byte-identical | none | **merge** |
| 7 | d3-force simulation in `layout.worker.ts` vs `scripts/precompute-force.ts` (`buildSimulation` / `mulberry32` / `SimNode` / `SimLink`) | exact copy-paste kept in sync by hand | extracted `src/lib/global/force-sim.ts`; re-ran `precompute:force` and diffed `positions` | positions identical; only the wall-time `ms` field differs (timing) | **merge** |
| 8 | global page `elkCovers`/`forceCovers` + `applyElkPositions`/`applyForcePositions` | near-identical, differing only in source label/fields | unified into `layout.covers` + `layout.applyPrecomputed`; browser: `d3-force-cache` and `elk-stress` metrics identical | none | **merge** |
| 9 | `aggregate.ts` `intraCalls: group.intraCalls` at node creation | value is always `0` there (edges are processed later and the final pass overwrites) | inspected control flow; changing it is a no-op and saves no lines | none | **keep** |
| 10 | `LayoutParams.collideStrength` / `collideIterations` | never set by the page's `PARAMS` | `rg`: read by the shared `force-sim` and relied on by `precompute-force` defaults | used (offline path) | **keep** |
| 11 | `RenderTreeOptions.maxChildren` (`src/lib/query/render.ts`) | no in-repo caller passes it | `rg`: read by `renderTree` (default 20); exported query API | no in-repo caller, but a public option | **keep** |
| 12 | `editor.ts` helpers (`EDITOR_PRESETS`, `DEFAULT_EDITOR_TEMPLATE`, `rawEditorConfig`, `editorTemplate`, `editorTarget`, `renderTemplate`) | no reference outside `editor.ts` | `rg` | used internally; exported library API | **keep** |
| 13 | global page `setStatus` wrapper | thin wrapper over `status = text` | used at several call sites; inlining saves nothing meaningful | none | **keep** |
| 14 | global page CSS classes | possible dead rules after the split | audited every selector against markup; toolbar/help CSS moved with their markup | none dead | **keep** |
| 15 | global page inline tooltip/search/handoff/pointer/keyboard/render/layout | one 1768-line file, heavy duplication of concerns | extracted to `$lib/global/*`; full browser checklist re-run | none | **merge** |
| 16 | `precompute-force.ts` / `precompute-elk.ts` shared `parseArgs` / `checkFile` / `assertNoOverlap` / `invokedDirectly` | duplicated CLI scaffolding | inspected; not merged (different flag sets, touches the 2-min ELK path) | still duplicated | **deferred** |

The static scans also surfaced many type-only exports and library entry points
with no in-repo caller (e.g. `OutlineIndex`, `EditorResult`, `BoundaryKind`,
`TraverseNode`, `resolveGraphFile`); those are intentional public API and were
kept.

## Refactor map

`src/routes/global/+page.svelte` (1768 → **968** lines) now keeps only the
reactive state + wiring. Extracted modules (all strict TS, no runes needed):

| Module | Responsibility |
|--------|----------------|
| `src/lib/global/colors.ts` | FNV hue, colour bucket, node fill, edge width |
| `src/lib/global/render.ts` | `drawScene` canvas renderer |
| `src/lib/global/geometry.ts` | view transform, fit, hit-test, box-select, zoom |
| `src/lib/global/layout.ts` | worker controller, `TICKS`/`PARAMS`, cover + apply-precomputed helpers, `GlobalMetrics` |
| `src/lib/global/force-sim.ts` | shared seeded d3-force simulation (worker **and** offline precompute) |
| `src/lib/global/handoff.ts` | symbol/file/dir maps, `toSymbolIds`, cap + persist |
| `src/lib/global/keyboard.ts` | typing guard + directional neighbour search |
| `src/lib/global/pointer.ts` | pointer/touch/wheel gesture machine |
| `src/lib/global/debug.ts` | `window.__global` handle builder (documented surface) |
| `src/lib/global/splitter.ts` | outline splitter drag |
| `src/lib/global/search.ts` | search matching |
| `src/lib/global/tooltip.ts` | tooltip content |
| `src/lib/components/GlobalToolbar.svelte` | toolbar + metrics readout |
| `src/lib/components/GlobalHelp.svelte` | `?` shortcut overlay |

## Verification

- `bun run check` → 0 errors / 0 warnings.
- `bun test` → 11 pass.
- `bun run build` → ok.
- Query CLI output unchanged (`callers … --json` sha256 identical to baseline).
- `precompute:force` positions byte-identical after the `force-sim` merge.
- Browser (agent-browser, `http://localhost:8191`), see the checklist in the
  commit/PR description: dir/file/symbol `nodeOverlapRatio === 0`,
  `d3-force-cache` instant symbol load, live `re-layout`, `elk-stress` toggle
  (`source:'elk-stress'`, 1780 nodes, overlap 0), outline + splitter + toolbar
  collapse, single-click/tap, touch pan/pinch, box-select → Local, search, `?`
  help; Local Q3 / hops / keyboard nav / `jumpToSource` / `?focus=`.

## Deferred

- Merge the `precompute-*` CLI scaffolding (#16) — low risk but touches the
  ELK precompute path; left for a follow-up.
- No micro-optimisation was applied: the measured layout times are unchanged
  (`dir ≈ 38 ms`, `file ≈ 353 ms`, `symbol live ≈ 6.1 s`, cached ≈ 39 ms) and no
  measured per-frame hotspot was identified beyond the existing O(n) hit-test,
  which is unchanged.
