# Global view UX pass (U1)

Notes for the global-density view improvements: full-height layout, sidebar
resize/collapse, touch gestures, single-tap activation, and instant consumption
of the cached offline `d3-force` symbol layout.

## 1. Full-height layout (no bottom gap)

The old page used `height: calc(100vh - 150px)` for both the tree and the
canvas, which left whitespace under the workspace and hard-coded the header
height.

Now the shell owns the height:

- `src/app.html` — the `%sveltekit.body%` wrapper is a real element
  (`<div id="app">`) instead of `display: contents`, so it can be a flex box.
- `src/routes/+layout.svelte` —
  - `html { height: 100% }`, `body { height: 100dvh; display: flex; flex-direction: column }`,
  - `#app { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column }`,
  - `main { flex: 1 1 auto; min-height: 0 }`.
  - `/global` gets `main.global-view { padding: 0; overflow: hidden; display: flex; flex-direction: column }`,
    so the workspace fills the whole remaining viewport with no page scroll.
- `src/routes/global/+page.svelte` — `.workspace` is `flex: 1 1 auto; height: 100%; min-height: 0`
  and `.stage` is `height: 100%; box-sizing: border-box`. The `150px` magic
  number is gone.
- `src/lib/components/OutlineTree.svelte` — the tree is `height: 100%` inside the
  flex row and `flex: 0 0 auto` so the resizable width is honoured (it no longer
  shrinks because the canvas claimed `width: 100%`).

The Local view keeps its existing `calc(100dvh - 8rem)` shell. It was verified
against the pre-change layout: `.local-app` renders at exactly the same
top/height (57..613 at 1280×633) as before, and the page has no scrollbars. The
only change is that `main` now extends behind the last 20 px with its own
(identical-colour) background.

## 2. Sidebar: collapse toggle, resize, richer rows

- The `«`/`»` collapse toggle moved from the sidebar edge into the graph toolbar's
  right-hand group (`.group.right`, pushed with `margin-left: auto`). It still
  hides/shows the whole tree + splitter.
- A 6 px splitter (`.splitter`) sits between the tree and the canvas using
  Pointer Events. Width is clamped to `[200, 760]` px and persisted to
  `localStorage` under `gpen.scip.outlineWidth` on pointer-up; it is restored on
  mount. The canvas `ResizeObserver` re-renders as the width changes.
- The per-row `[local]` button was removed from `OutlineTree.svelte` (the
  toolbar `→ Local (N)` handoff is untouched). The freed row space shows the node
  name in full — labels wrap (`overflow-wrap: anywhere`) instead of truncating —
  plus a muted `kind` tag and the existing descendant `count`.
- Symbol rows still call `onfocussymbol`; file rows still call `onfocusfile`;
  non-leaf rows still toggle.

## 3. Touch gestures and single-tap activation

Pointer Events are used for both mouse and touch; the canvas sets
`touch-action: none` so the browser does not hijack pan/pinch.

- **Pan** — first pointer down starts a `pan` drag (unless Shift). The same code
  path handles touch and mouse because pointer capture is used.
- **Pinch zoom** — a second active pointer switches the gesture into pinch mode:
  the view scales around the midpoint and tracks midpoint translation. A
  `suppressTap` latch keeps the trailing finger-up from being read as a tap.
- **Box select** — Shift + drag still draws and finalizes the selection box.
- **Wheel zoom** — unchanged.
- **Activation** — `ondblclick` was removed. On pointer-up, if the pointer moved
  less than `TAP_SLOP` (6 px) it is treated as a tap: the node under the pointer
  is selected (`select([id])`), otherwise the selection is cleared. A real pan
  (movement above the slop) never selects. This makes single click / single tap
  select a node.

`window.__global` gained a `positions()` accessor (matching `nodeIds()` /
`screenPos()`) used to dump a layout for cache-path testing.

## 4. Cached `d3-force` symbol layout

`src/routes/global/+page.server.ts` already loads the optional precomputed file
via `loadForce()` (`static/d3force-symbol.json`, env override
`SCIP_GRAPH_FORCE_FILE`). The page now consumes it:

- On mount the positions are indexed into a `Map<id, ForcePosition>`.
- In `relayout()`, when `layoutMode === 'd3-force'` **and** `level === 'symbol'`
  **and** `forceCovers()` (every symbol node has a cached position), the layout is
  applied on the main thread — no worker round-trip. `applyForcePositions()`
  re-derives overlap/fill with `computeMetrics()` and reports
  `source: 'd3-force-cache'` plus the offline `precomputeMs`.
- The explicit **re-layout** button calls `relayout(true)`, which skips the cache
  and forces a fresh live worker run.
- When the file is absent (or the cached ids do not cover the graph) the page
  falls back to exactly the previous live-worker behaviour.

## Verification

All on `bun run dev -- --port 8181`, driven with `agent-browser`.

- `bun run check`, `bun test` (11 pass), `bun run build` all pass.
- Full height: `canvas` bottom = 632 vs `innerHeight` 633, `documentElement.scrollHeight - innerHeight = 0`
  (no page scrollbars); tree and splitter fill the same interval.
- Collapse: `.collapse-toggle` is inside `.toolbar`; toggling hides/shows `.outline`.
- Resize: dispatching a splitter drag moved the tree from 300 px to 420 px and
  wrote `gpen.scip.outlineWidth = "420"`; reload restored 420 px.
- Tree: `document.querySelectorAll('.outline .open').length === 0`, rows expose
  `kind` + `count`, and no label was measured as truncated.
- Activation: a synthetic single click selected a node; a touch tap selected a
  node with `dx = dy = 0` (no pan); a touch drag of (90, 50) panned the graph by
  exactly (90, 50) with the selection unchanged; a two-finger pinch changed
  `view.k` by exactly 2.0 with the selection unchanged.
- Cache path (tested via a temporary `SCIP_GRAPH_FORCE_FILE` pointing at positions
  dumped from a live run — the tracked `static/d3force-symbol.json` was not
  created or modified): `setLevel('symbol')` produced
  `source: 'd3-force-cache'`, `nodeOverlapRatio: 0` in ~40 ms, while the
  **re-layout** button then showed `computing symbol layout in worker…` and
  finished with `source: 'd3-force'` in ~6.9 s.
- Overlap: `window.__global.metrics()` reports `nodeOverlapRatio: 0` at both
  `dir` (23 nodes) and `symbol` (1780 nodes).

Screenshots: `docs/shots/u1-fullheight.png`, `docs/shots/u1-sidebar.png`,
`docs/shots/u1-tap.png`.
