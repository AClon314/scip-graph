# Global view: URL-selected sync, size-by-degree, always-visible selected labels (U7)

Three global-view features: the selection is mirrored into the URL and restored
(with auto-focus) on reload; node rectangles can be sized by call degree from a
persisted toolbar checkbox; and selected/hovered labels stay readable at any
zoom. The page was also trimmed back under the 1000-line guideline by extracting
focused modules (see “Module layout” below).

## 1. `?selected=[…]` URL sync + auto-focus

**Writing.** Every selection change funnels through `select()` →
`updateSelectionUi()`, which calls `syncSelectionUrl()`. That delegates to
`writeSelectionToUrl(ids)` in `src/lib/global/selection-url.ts`:

- the `selected` param is a single JSON string array (`JSON.stringify(ids)`),
  set through `URLSearchParams` so it is encoded correctly
  (`?selected=%5B%22src%2F…%22%5D`);
- it uses SvelteKit `replaceState` — **no navigation, no history entries**; every
  other query param (e.g. `?foo=bar`, `?ids=`) is preserved;
- an empty selection removes the param.

Because tap/click, box-select (`finalizeBoxSelect`), keyboard arrows
(`moveSelection`), outline rows, `focus()`/`focusSymbol()`/`focusFile()` and
`window.__global.select()` all go through `select()`, the URL stays in lockstep
with all of them. Clearing the selection from `setLevel()` also goes through
`updateSelectionUi()`, so a stale `selected` is removed.

**Reading.** `bootstrap()` hands the URL params and the localStorage handoff to
`applyBootstrapSelection()` (`src/lib/global/preselect.ts`). Precedence is
`selected` → `?ids=` → handoff:

- `parseSelectedParam` does a `JSON.parse` in try/catch and keeps only strings
  (malformed JSON ⇒ no selection);
- `chooseLevel(ids, levelIdSets)` picks the level that owns the most ids, with a
  symbol → file → dir preference on ties (so a 3-segment file path like
  `src/embed/index.ts`, which is also a valid dir key, restores at `file`);
- the legacy `?ids=` and handoff paths keep their old behaviour (always symbol
  level);
- only ids that exist at the chosen level are selected.

After selecting, `focusSelection()` frames the selection with
`selectionBounds()` + `zoomToBounds()` (120 px padding, with a minimum
240 × 160 world footprint so a single small node is not blown up to max zoom).
URL writes are suppressed while bootstrap applies the selection, then normalised
once at the end. `?ids=`/handoff keep `fit()` so their previous behaviour is
unchanged.

## 2. Toolbar “size by degree” (default on, persisted)

`GlobalToolbar.svelte` gains a checkbox labelled **size by degree**
(`title="node size reflects call degree — in + out"`), checked by default and
persisted to `localStorage["gpen.scip.sizeByDegree"]`.

`aggregate(graph, level, { sizeByDegree })` now computes an `AggNode.degree`:

- **symbol**: the raw `SgNode.weight` (in + out call degree);
- **dir / file**: the sum of the members’ `weight`s (group call activity).

When checked (the default) the rectangle scale is
`scaleFor(degree, medianDegree)` (the existing bounded `sqrt`, clamped
`[0.75, 2.2]`); when unchecked every rect is the uniform base size
(`hw = BASE_W/2`, `hh = BASE_H/2`). `weight` is unchanged (member count at
dir/file, degree at symbol) and the tooltip now shows `degree` alongside it. At
symbol level the degree-driven sizing is identical to before, so the
precomputed `d3-force` cache stays valid.

Toggling re-aggregates **without a full relayout** via
`reaggregateForSize()` (`src/lib/global/size-mode.ts`): it rebuilds the
aggregation, copies the existing positions back, re-runs the deterministic
`separateRects()` cleanup for the new sizes (so `nodeOverlapRatio === 0` still
holds after rects grow/shrink), re-derives `computeMetrics()` and re-fits the
view. It falls back to `relayout()` only when positions do not exist yet. In
addition, `applyPrecomputed()` now re-runs the same rect separation after
applying a cached layout, so loading directly with the toggle off (uniform
rects) is also overlap-free.

## 3. Selected labels are never hidden

`render.ts` still draws inline labels for all nodes only when
`showLabels && w > 30 && h > 10`. Now, when that gate fails but the node is
**selected or hovered**, a label chip is queued and drawn after the node loop:

- fixed ~11 px screen font, independent of zoom;
- a rounded background chip with a selected (`#ffd54a`) / hovered (`#ffffff`)
  border, positioned above the node (below when it would clip), clamped to the
  canvas;
- the text is clipped at 48 chars with an ellipsis.

Non-selected nodes keep the existing zoom-gated behaviour. Pure rendering: no
layout, metric or hit-testing change.

## Module layout

`src/routes/global/+page.svelte` (871 lines) delegates to focused modules under
`src/lib/global/`:

| module | responsibility |
| --- | --- |
| `selection-url.ts` | parse/write `selected`, `chooseLevel` |
| `preselect.ts` | bootstrap precedence (`selected` → `ids` → handoff) |
| `size-mode.ts` | in-place re-aggregation for the size toggle |
| `neighbors.ts` | selection caller/callee/edge counts |
| `keys.ts` | global keydown shortcut table |
| `handoff-anim.ts` | selection pre-animation for Global → Local |

The page’s styles moved to `src/routes/global/global.css`, with presentational
rules scoped under `.stage` so they cannot leak into the outline sidebar, the
Local view or the landing page.

## Verification

All on `bun run dev -- --port 8193`, driven with `agent-browser`. `bun run check`,
`bun test` (11 pass) and `bun run build` all pass.

- **URL sync**: `select(["src/lib/components"])` at `dir` produced
  `?selected=%5B%22src%2Flib%2Fcomponents%22%5D`; with `?foo=bar` loaded first
  the result was `?foo=bar&selected=…` (other params preserved); clearing the
  selection removed the param. Keyboard `ArrowRight` and `Escape` updated the
  URL identically.
- **Auto-focus on reload**: reloading `?selected=["src/lib/components"]` restored
  the `dir` selection and reframed the viewport from
  `(x 580, y 195, k 1.00)` to `(x 478, y 287, k 2.84)` (canvas centre). A symbol
  id restored at `symbol` level and a 3-segment file id at `file` level, both
  centred.
- **Size by degree**: at symbol level the widths ranged 45–132 px when checked
  (low vs high degree) and were exactly `60` (one distinct width) when
  unchecked; `nodeOverlapRatio === 0` in both states, and the choice persisted
  across a reload (`localStorage = "1"`/`"0"`). At dir level 11 distinct widths
  (45–132) were observed with overlap 0.
- **Selected label**: `window.__global.fit()` at symbol level (k ≈ 0.143, node
  width ≈ 8.6 px, no inline labels) still rendered the selected node’s label
  chip. `window.__global.metrics()` was otherwise unchanged.
- **Handoff**: the `→ Local (1)` button animated and navigated to
  `/local?ids=…` (the extracted `handoff-anim` module).

Screenshots: `docs/shots/u7-url.png`, `docs/shots/u7-size-by-degree.png`,
`docs/shots/u7-selected-label.png`.
