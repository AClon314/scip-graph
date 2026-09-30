# Phase 5 (polish) — global half

Scope: `src/routes/global/+page.svelte`, `src/routes/+layout.svelte`,
`src/lib/graph/outline.ts`, `src/lib/components/OutlineTree.svelte`.
The Local view (`src/routes/local/**`, `src/lib/local/**`, `src/lib/editor.ts`)
is owned by a sibling branch.

## 1. Outline tree (`repo → dir → file → symbol`)

`src/lib/graph/outline.ts` builds a pure-data tree from the frozen `SgGraph`:

- directories nest by path segment; every file owns its symbol leaves in line
  order; each node carries a descendant-symbol `count`.
- helpers: `buildOutline`, `indexOutline`, `collectSymbolIds`,
  `firstSymbolId`, `ancestorsOfSymbol`, `visibleRows`, `filterOutline`.

`OutlineTree.svelte` renders a flat, indented list of the visible rows (cheap
for 1780 symbols, easy to `scrollIntoView`) behind a `role="tree"`.

- collapsible nodes with counts, expand/collapse-all, and a filter box;
  filtering keeps ancestors, auto-expands hits, and treats a path match as
  "keep the whole subtree".
- clicking a symbol selects + centres it on the canvas (switching to `symbol`
  level when needed); clicking a file focuses the file-level node.
- every non-leaf exposes a **Local** button that resolves its symbols via
  `collectSymbolIds` and hands them to `/local?ids=…`.
- the current canvas/box selection is highlighted; the tree auto-reveals the
  ancestors of a selected symbol and scrolls it into view.

It is mounted as a collapsible left sidebar; the canvas uses a `ResizeObserver`
so collapsing the panel re-fits the drawing surface.

## 2. Keyboard navigation

Window-level handler (ignored while typing in an input/textarea):

| key | action |
| --- | --- |
| `← ↑ → ↓` | move the selection to the nearest node in that direction (alignment-biased score `primary + 2.2·cross`) |
| `+` / `-` | zoom about the viewport centre |
| `0` | fit graph to view |
| `/` | focus the outline filter box |
| `Enter` | centre the selection and open it in Local |
| `j` | jump to source (`$lib/global/jump`) |
| `Esc` | close help, else clear the selection |
| `?` | toggle the shortcut help overlay |

The keyboard-only flow **`/` → type → `Enter`** selects the first matching
symbol and lands on `/local?ids=<symbol>`.

## 3. Handoff + A↔B transition

`openLocal` resolves *any* mix of symbol / file / dir ids to a de-duplicated
symbol list using a graph-wide `symbolsByFile` / `symbolsByDir` index, so the
`→ Local` button and `Enter` work at every level. The list is capped at 64 ids
(the query string still carries them; `localStorage` mirrors the old handoff).

`+layout.svelte` wires `onNavigate` to `document.startViewTransition` (guarded
for browsers without the API), giving Global↔Local a crossfade. On the Global
side the selected nodes are first **zoomed and glow-elevated** over ~240 ms
(`elevate` pulse in the canvas renderer) before `goto` fires, so the transition
reads as a continuation.

## 4. Debug handle

`window.__global` keeps `setLevel / select / selection / metrics / relayout /
fit / labels / nodeIds / screenPos` and adds `focus(id)` (select + centre,
switching to the level that owns the id), `center(id)`, `openLocal(ids?)` and
`level()`.

## Verify (this branch)

- `bun run check` → 0 errors / 0 warnings; `bun run build` → ok.
- `bun run derive -- --scip …/index-fork.json --out static/graph.json` →
  1780 nodes / 2001 edges.
- `window.__global.metrics()` after `setLevel`: `dir` 23 nodes, `file` 135,
  `symbol` 1780 — `nodeOverlapRatio = 0` at all three levels.
- Outline expansion + symbol click drives the canvas selection; the selected
  row highlights and ancestors auto-reveal.
- Keyboard flow `/` → `mountGpen` → `Enter` →
  `/local?ids=src/embed/index.ts:52`; a transition is recorded exactly once
  and no page errors are raised. Local→Global also fires one transition.
- Screenshots: `docs/shots/p5-global-outline.png`,
  `p5-global-keyboard.png`, `p5-transition.png` (crossfade captured with a
  temporarily slowed transition).

## Deferred

- No named-element morph between the two canvases: during an SPA view
  transition both pages are mounted, so reusing a `view-transition-name` would
  collide. The transition is a root crossfade plus the pre-navigation glow.
- `jumpToSource` is still the stub seam (logs the target + toast); a real
  editor hand-off stays out of scope.
