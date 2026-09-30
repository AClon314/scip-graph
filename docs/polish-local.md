# Phase 5 — local-view polish

Local half of the Phase 5 polish pass: crossing hops, keyboard navigation and
editor ↔ view sync. Only the local view / `$lib/local` / `$lib/editor` are
touched; the global view is unchanged.

## 1. Semicircular hops on crossings

When two drawn bezier edges cross, one of them bridges the crossing with a
small semicircle so the eye can tell them apart.

- **Pure rendering.** Hops are computed on the drawn geometry inside
  `src/lib/local/render.ts` (`computeHops`) and never feed back into layout,
  sorting or any metric. `expand()` / `sortColumns()` are untouched.
- **Only visible geometry.** Every non-internal edge between the currently
  visible columns is sampled (16 segments), bounding boxes are rejected first,
  then segment/segment intersections are found; the later-drawn edge of each
  crossing pair gets a hop. Edges sharing a node (fan-out from/to one node) are
  skipped because they only meet at the node.
- **Deterministic direction.** The bump always bulges to the smaller-`y` side;
  the bump is a single cubic approximating a semicircle (control offset
  `4/3·R`).
- **Toggle.** `hops` is a new `LocalOptions` flag (default `false`), exposed as
  the toolbar checkbox **“hops on crossings”** and the `+` / `-` keyboard keys.
  Toggling does not rebuild columns or reset scroll.
- **Debug.** `window.__local.renderer.debugHopCount()` returns the number of
  hops drawn in the last frame (used for verification).

Limitations:

- Edges that overlap **collinearly** (not a transversal crossing) are not
  detected — the segment test rejects (near-)parallel overlaps.
- Internal centre self-loop edges are excluded (they are drawn as loops and
  would interact with the fan-out heuristic).
- A hop pair is only detected when the two edges do not share an endpoint uid;
  by design this avoids spurious hops where edges only meet at a node.

Screenshot: [`docs/shots/p5-local-hops.png`](shots/p5-local-hops.png)
(`src/lib/components/workspace/GpenWorkspace.svelte:526`, 19 hops — hop count
read from `debugHopCount()`).

## 2. Keyboard navigation

Focus lives in the renderer (so it can pick the nearest node using real
geometry) and is mirrored into the status bar. The focused node gets a gold
ring.

| Key                 | Action                                                             |
| ------------------- | ------------------------------------------------------------------ |
| `↑` / `↓`           | focus previous / next node in the current column                   |
| `←` / `→`           | focus the nearest node (by vertical centre) in the adjacent column |
| `Enter`             | re-center on the focused node                                      |
| `Shift+Enter`       | add / remove the focused node from the focus set                   |
| `+` / `=`           | show hops on crossings                                             |
| `-` / `_`           | hide hops on crossings                                             |
| `j`                 | open the focused node in the editor                                |
| `/`                 | focus the node-id search input                                     |
| `Esc`               | clear focus / close the shortcut overlay                           |
| `?`                 | toggle the shortcut help overlay                                   |

Key handling never fires while typing in an input/textarea/select/contenteditable
(except `Esc`, which always clears). Renderer helpers:
`setFocus`, `clearFocus`, `getFocused`, `focusInfo`, `moveFocus`.

Screenshot: [`docs/shots/p5-local-keyboard.png`](shots/p5-local-keyboard.png)
(help overlay + fallback jump toast).

## 3. Editor ↔ view sync

See [`editor-sync.md`](editor-sync.md) for the full contract. Summary:

- `src/lib/editor.ts` resolves `PUBLIC_SCIP_GRAPH_EDITOR` (preset name or URL
  template with `{file}` / `{line}` / `{column}`) and `openInEditor(node)` uses
  `SgNode.range` with a `line` fallback.
- `src/lib/local/jump.ts` emits `scip-graph:jump` (always) and calls
  `openInEditor` when configured; otherwise the page shows a fallback toast and
  logs the target.
- Inbound: `?focus=<file>:<line>` (plus `?ids=`), `window.__local.reveal(...)`,
  `window.__local.setFocus(...)`, and the `scip-graph:focus` window event.
- `j` / right-click produce the editor URL (toast + status) or the fallback
  toast when no editor is configured.

Screenshot: [`docs/shots/p5-editor-sync.png`](shots/p5-editor-sync.png)
(`?focus=…:115` reveal + highlight + toast).

### `window.__local` debug surface

New in this pass (existing `setCenter` / `state` / `setSort` / `toggle` remain):

```ts
reveal(target: string): boolean;
focus(): FocusInfo | null;
setFocus(target: string | null): boolean;
moveFocus(dir: 'up' | 'down' | 'left' | 'right'): FocusInfo | null;
editorUrl(nodeOrId: SgNode | string): string | null;
hops(enabled?: boolean): boolean;
```

`renderer` is still exposed; it now also has `debugHopCount()`.

## Verification

```
bun run check   # 0 errors, 0 warnings
bun test        # 11 pass
bun run build   # ok
```

Browser (agent-browser, `http://localhost:8172`):

- **Q3 regression** — `/local?ids=src/lib/components/areas/CodeArea.svelte:86`
  → `state().left` contains `…/CodeArea.svelte:115`.
- **Hops** — `GpenWorkspace.svelte:526` with the toggle on →
  `debugHopCount() === 19`, no console errors / page errors.
- **Keyboard** — `↓` starts focus at the centre, `←`/`→` move between columns,
  `Enter` re-centers, `Shift+Enter` extends `state().center`, `Esc` clears,
  `+`/`-` toggle hops, `?` opens help, `/` focuses the input.
- **Editor sync** — with
  `PUBLIC_SCIP_GRAPH_EDITOR='vscode://file/{file}:{line}:{column}'`,
  `/local?focus=…:115` reveals + highlights it, `editorUrl(…)` and `j` produce
  `vscode://file/src/lib/components/areas/CodeArea.svelte:115:11`; the
  `scip-graph:focus` event and `reveal(...)` both re-center.
