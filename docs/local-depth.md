# Local view — configurable hop depth + horizontal scrolling

The local butterfly view used to expand a fixed ±2 neighbourhood (`L2,L1,C,R1,R2`).
This change makes the hop depth configurable and lets the column strip scroll
horizontally when the extra columns no longer fit the viewport.

Only `src/lib/local/**` and `src/routes/local/**` are touched; the global view,
query CLI, schema and scripts are unchanged.

## 1. Configurable depth

A new toolbar control **depth** is a positive integer input:

```html
<input type="number" min="1" step="1" … />
```

- **Default `2`** (`DEFAULT_DEPTH` in `src/lib/local/model.ts`).
- Controls how many caller/callee levels are expanded: `L1..LN` on the left and
  `R1..RN` on the right, with `L1`/`R1` nearest the centre.
- **Clamping.** `clampDepth(n)` floors to an integer and forces `>= 1`; garbage
  (`abc`, empty), `0` and negatives never change the model. The field live-applies
  sane values while typing and normalises on blur.
- **Persistence.** The value is stored in `localStorage` under
  `gpen.scip.local.depth` and restored on load.
- **Natural termination.** Expansion is a BFS that excludes every node already
  seen at a nearer level, so a node only appears in the closest column that
  reaches it. When a level reaches no new nodes the model stops, so no `max` is
  required — a large depth is safe.

### Labels

| Depth | Left       | Right          |
| ----- | ---------- | -------------- |
| `1`   | `callers`  | `callees`      |
| `n>1` | `ancestors n` | `descendants n` |

### Model changes (`src/lib/local/model.ts`)

- `expand(graph, centerIds, options, depth = DEFAULT_DEPTH)` builds the dynamic
  columns by repeatedly calling `neighborMap` with the growing `seen` set.
- Neighbouring-column edge wiring iterates the dynamic column list, so the
  `L(n+1)→Ln→…→L1→C→R1→…→Rn` chains are wired generically.
- `bypassItems`, tree/graph mode, sorting and reachability are unchanged; the
  outermost-column `hasMore` hint now keys off the deepest visible level per
  side.
- `minCrossing` walks the dynamic `L`/`R` chains from the centre outward.
- `columnsState()` now returns `leftLevels` / `rightLevels` (`string[][]`,
  index 0 = nearest the centre) alongside the flattened `left` / `right`; the
  legacy `left1`/`left2`/`right1`/`right2` fields are kept for compatibility.

## 2. Horizontal scrolling (`src/lib/local/render.ts`)

`layout()` now iterates the dynamic column keys on each side (deepest first)
instead of the hardcoded `['L1','L2']` / `['R1','R2']`.

- **Depth scaling.** `depthScale(depth) = max(0.5, 1 - 0.17·depth)` replaces the
  fixed `{0:1, 1:0.82, 2:0.66}` table, so deeper columns shrink gently and never
  below half size.
- **Anchor when it fits.** If the whole strip is no wider than the viewport the
  centre stays anchored at the middle and no horizontal scroll is offered.
- **Pan when it overflows.** Otherwise the strip can be panned with clamping so
  the leftmost and rightmost columns can both be revealed:
  - **shift+wheel** (or a trackpad horizontal `deltaX`) pans horizontally;
  - a **horizontal scrollbar** at the bottom of the canvas can be dragged (or
    clicked to jump);
  - dragging the empty background pan/scrolls the strip.
  - Keyboard focus that moves off-screen horizontally pans the strip to keep the
    focused column visible.
- **Wheel still scrolls the hovered column vertically; Ctrl+wheel zoom is
  unchanged.**

`window.__local.renderer.debugStrip()` returns the current
`{fits, contentW, minPan, maxPan, pan, panSmooth, …}` for verification.

## 3. `window.__local` debug API

- `state()` gains `depth`, `leftLevels` and `rightLevels` (plus the existing
  fields).
- `setDepth(n)` sets the depth, persists it and rebuilds; returns `true`.
- The footer shows `depth n` and a per-level breakdown
  (`L1 x/L2 y/…`, `R1 …`).

## Verification

- `bun run check`, `bun test`, `bun run build` all pass.
- Q3 regression at depth `2`: `/local?ids=src/lib/components/areas/CodeArea.svelte:86`
  → `state().left` contains `CodeArea.svelte:115`.
- Depth `1` → only `L1,C,R1` (and the strip fits, centre anchored).
- Depth `3` on a deeper centre → `L3`/`R3` appear with the correct reachability.
- Depth `6` → the strip overflows (`fits:false`) and pans within
  `[minPan, maxPan]`.

Screenshots:

- [`docs/shots/u7-depth-3.png`](shots/u7-depth-3.png) — depth `3` on
  `src/lib/bindings/storage/objects/kv.ts:162`, all seven columns visible.
- [`docs/shots/u7-depth-scroll.png`](shots/u7-depth-scroll.png) — depth `6`,
  strip panned with the horizontal scrollbar visible.
