# Precompute — cached layouts + shared progress renderer

Scope: `scripts/**` (new `progress.ts`, `precompute-force.ts`; refactored
`precompute-elk.ts`), `package.json` scripts, this doc. The global page/UI and
`src/lib/**` are owned by the sibling change; the precompute scripts only *read*
`src/lib/global/*` (`aggregate`, `rect-separation`, `metrics`, `elk-stress`,
`force-cache`).

The global symbol view has two layout backends that are slow enough to be worth
caching offline:

| backend | live cost | cache file | npm script |
| --- | --- | --- | --- |
| `d3-force` | ~6.5 s in a Web Worker | `static/d3force-symbol.json` | `precompute:force` |
| `elk-stress` | ~120 s single-threaded ELK.js | `static/elk-stress-symbol.json` | `precompute:elk` |

Both files are derived and graph-specific, so they are `.gitignore`d. Both
scripts, when the file is absent, make the app fall back to the live path
(`loadForce()` / `loadElkStress()` return `null`).

## 1. `scripts/progress.ts` — tiny multi-metric renderer

A single dependency-free class (no `cli-progress`) shared by both precompute
scripts. On a TTY it redraws a small block of live lines **in place** with ANSI
`\x1b[<n>A` (cursor up) + `\x1b[0J` (clear below); when the stream is not a TTY
it degrades to periodic single-line snapshots.

```ts
import { Progress } from './progress';

const p = new Progress({ label: 'precompute:force' });
p.set('nodes', 1780);          // arbitrary named metric
p.section('d3-force', 'tick'); // phase + optional progress-bar label
p.tick(120, 400);              // absolute bar (current, total)
p.tick(10);                    // increment by 10
p.section('cleanup', 'pass');  // unknown total -> renders as a live counter
p.tick(89, 0);
p.done();                      // finalize; the last frame stays on screen
```

Live frame on a TTY (colours stripped):

```
[precompute:force] d3-force  elapsed 4.1s  iter 160/400  eta 6.2s
  tick [######----------]  40%  160/400
  nodes 1780 · edges 1986 · overlap 203 · fill 0.2536
```

Non-TTY fallback (one line, throttled to `plainIntervalMs`, default 2 s):

```
[precompute:force] | d3-force | elapsed 4.1s | tick [######--] 40% 160/400 | nodes 1780 | edges 1986 | overlap 203 | fill 0.2536
```

API: `section(name, barLabel?)`, `set(key, value)`, `tick(amountOrCurrent?,
total?)`, `done(message?)`. The heartbeat only drives time-only updates (e.g.
while awaiting `elk.layout`) and is `unref()`d so it never keeps the process
alive.

## 2. `scripts/precompute-force.ts` — cached d3-force

Faces the same interface as the ELK cache (`src/lib/global/force-cache.ts`):

```
static/graph.json
  └─ aggregate(graph, 'symbol')                 (src/lib/global/aggregate.ts)
       └─ d3-force simulation                   (mirrors layout.worker.ts)
            └─ deterministic rect-separation    (run until zero overlap)
                 └─ static/d3force-symbol.json
```

`layout.worker.ts` is a Worker entry point (`self.onmessage = …`), so it cannot
be imported in Node. `precompute-force.ts` therefore mirrors its symbol-level
setup exactly — same seeded phyllotaxis start (`mulberry32`), same forces
(`forceLink` / `forceManyBody` / `forceCollide` / `forceCenter`), same
`PARAMS.symbol` / `TICKS.symbol` from `src/routes/global/+page.svelte` — and
reuses the *shared* `radiusOf` / `separateRects` / `countOverlaps` from
`src/lib/global/rect-separation.ts` (the single source of truth for cleanup).
`d3-force` v3 itself is deterministic: it seeds its jiggle RNG with an internal
LCG, not `Math.random()`.

Output shape (matches `ForceLayout`):

```jsonc
{
  "level": "symbol",
  "algorithm": "d3-force",
  "ms": 9253,            // simulation + cleanup wall time
  "iterations": 400,     // ticks actually run
  "cleanupPasses": 0,    // 0: the settled run was already overlap-free
  "positions": [{ "id": "src/embed/index.ts:35", "x": …, "y": …, "w": …, "h": … }]
}
```

`x`/`y` is the **centre** of the drawn rectangle, `w`/`h` its full extent —
the same convention as `ElkStressPosition`.

CLI:

```bash
bun run precompute:force                       # full default run
bun scripts/precompute-force.ts --ticks 60     # shorter, for progress demos
bun scripts/precompute-force.ts --seed 42
bun scripts/precompute-force.ts --check        # validate existing file, don't recompute
```

The cleanup runs in 500-pass rounds until zero overlap (hard-capped at 20 000),
the same "run until clean" strategy `precompute:elk` uses. The script
`assert`s zero overlap before writing and reports `overlap 0`.

## 3. `scripts/precompute-elk.ts` (refactored)

Unchanged pipeline and output format; it now drives the same `Progress`
renderer (`elk-stress` phase, then a `cleanup pass k` counter). `--check` still
prints the one-line `[precompute:elk] ok …: N positions, overlap R, fill F`.

```bash
bun run precompute:elk
bun run precompute:elk -- --check
```

## 4. npm scripts

```jsonc
"precompute:force": "bun scripts/precompute-force.ts",
"precompute:elk":   "bun scripts/precompute-elk.ts",
"precompute:all":   "bun run precompute:force && bun run precompute:elk"
```

`precompute:all` runs the fast force cache first, then the slow ELK cache.

## 5. Verification

Measured on the gpen fork index (1780 symbol nodes, 1986 symbol edges):

| step | wall time | details |
| --- | --- | --- |
| `precompute:force` | **9.3 s** | 400 iterations, 0 cleanup passes, fill 0.2476 |
| `precompute:elk` | **127.2 s** | ELK 112 959 ms + 4394 cleanup passes, fill 0.0786 |

Both write **1780 positions** and re-derive `overlap 0` from the file.

```bash
bun run precompute:force
bun run precompute:force -- --check     # 1780 positions, overlap 0
bun run check && bun test && bun run build
```

The server loader (`src/lib/server/loadGraph.ts`) already exposes
`loadForce()`; `src/routes/global/+page.server.ts` passes
`forcePositions: await loadForce()` into the page. When the file exists the
loader returns a non-null `ForceLayout`, so the sibling UI can apply the cached
positions without a worker round-trip.
