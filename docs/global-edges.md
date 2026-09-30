# Global edges: direction arrowheads + selection caller/callee status (U6)

Two focused global-view features: every aggregated edge now shows its direction,
and a selection reports how many distinct callers/callees it has.

## 1. Arrowheads on every global edge

`src/lib/global/render.ts` (`drawScene`, edge loop) previously stroked a plain
centre-to-centre line. Each edge now ends in a small filled triangle at the
**target** end, so `A → B` reads “A calls B”.

Geometry (screen space, from the two node centres `a`/`b`):

- The drawn rect for `b` is `b.hw * k × b.hh * k` (half extents, scaled by the
  view zoom `k`). The centre-to-centre segment is intersected with that rect:
  `m = min(bw / |dx|, bh / |dy|)` is the fraction of the way back from `b`’s
  centre toward `a`, so the trimmed endpoint `b - m·(b - a)` lies exactly on the
  border. The arrow tip is placed there.
- Overlap guard: if the two screen rects overlap
  (`|dx| < (a.hw + b.hw)·k && |dy| < (a.hh + b.hh)·k`) the raw line is drawn
  with no arrowhead.
- Short-segment guard: the head is dropped when the trimmed segment is
  `< ~10 px`, which also covers `m ≥ 1` (degenerate/contained cases).

Style and size:

- The triangle inherits the edge’s `strokeStyle` (via `fillStyle`) and
  `globalAlpha`, so dim / active / search fading and `virtual` colouring all
  apply unchanged.
- Size is `clamp(3 + edgeScreenWidth(calls) * 1.7, 5, 11)` px — modest, and it
  never grows past the node it points at.

Pure rendering: no layout, metrics or hit-testing is touched. The edge loop
inlines `worldToScreen` (scalar-only) and the helper allocates nothing, so the
~2000-edge symbol view stays allocation-free per edge. The same code path serves
every level (`dir` / `file` / `symbol`) and every layout mode (live d3-force,
cached d3-force, `elk-stress`).

## 2. Selection caller/callee status

`src/routes/global/+page.svelte` derives:

- `callers` — distinct sources of incoming edges (`target ∈ S`, `source ∉ S`);
- `callees` — distinct targets of outgoing edges (`source ∈ S`, `target ∉ S`).

It walks the current `agg.edges`, so at group levels the counts are distinct
adjacent groups; for a single symbol node they are exactly its in/out degree.

The result is a `$derived` (recomputed on selection and level change) rendered
next to the `→ Local (N)` button as `callers N · callees M`, with
`· edges K` appended for multi-select. A `title` attribute spells out the
definition. It is intentionally separate from the transient `status` variable
(“computing layout…”), which is untouched.

## Verification

- Symbol level, selection `src/lib/components/areas/CodeArea.svelte:86`:
  `callers 1 · callees 1`, matching
  `scip-graph refs "src/lib/components/areas/CodeArea.svelte:86"` (incoming
  `:115`, outgoing `codeArea/source.ts:33`).
- Direction checked on `src/lib/components/areas/CodeArea.svelte:115 → :86`:
  the triangle sits on the `:86` border pointing along the edge.
- Arrows confirmed at `dir`, `file`, `symbol` and `elk-stress`; console clean;
  `window.__global.metrics().nodeOverlapRatio === 0` unchanged.
- Screenshots: `docs/shots/u6-arrows.png`, `docs/shots/u6-selection-status.png`.
