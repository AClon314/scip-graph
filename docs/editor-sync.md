# Editor ↔ scip-graph sync

The **local** butterfly view is the deep-dive surface: an editor (or any host)
can drive it to a symbol, and the view can push the user back to the editor.
This document is the contract for both directions.

## Configuration

The transport is configured with the public env var `PUBLIC_SCIP_GRAPH_EDITOR`.
Because SvelteKit reads public env at runtime (`$env/dynamic/public`), change it
when starting the dev server / build and reload the page:

```bash
PUBLIC_SCIP_GRAPH_EDITOR='vscode://file/{file}:{line}:{column}' bun run dev
```

Accepted values:

| Value                          | Result                                                            |
| ------------------------------ | ----------------------------------------------------------------- |
| unset / empty                  | **no editor configured** → `j` shows a fallback toast             |
| `vscode`, `code`               | `vscode://file/{file}:{line}:{column}`                            |
| `vscode-insiders`              | `vscode-insiders://file/{file}:{line}:{column}`                   |
| `cursor`                       | `cursor://file/{file}:{line}:{column}`                            |
| `idea`                         | `idea://open?file={file}&line={line}`                             |
| `sublime`                      | `subl://open?url=file://{file}&line={line}`                       |
| `none`, `off`, `false`, `0`    | no editor configured                                              |
| any other non-empty string     | used as a URL template containing `{file}` / `{line}` / `{column}` |

Positions are **1-based**. `SgNode.range.start` wins over `SgNode.line`; the
column falls back to `1` when the derive step recorded no range.

`src/lib/editor.ts` owns resolution:

```ts
import { isEditorConfigured, editorTarget, resolveEditorUrl, openInEditor } from '$lib/editor';

isEditorConfigured();          // boolean
editorTarget(node);            // { id, file, line, column, range? }
resolveEditorUrl(node);        // string | null
openInEditor(node);            // { configured, url, target } + best-effort navigation
```

## Outbound — view → editor

`src/lib/local/jump.ts` is the single entry point.

- `j` (keyboard, focused node) and the canvas context-menu call `jumpToSource`.
- `jumpToSource(node)`:
  1. resolves the 1-based request (range → line → column),
  2. always dispatches the `scip-graph:jump` window event,
  3. when an editor is configured, calls `openInEditor(node)`;
     otherwise it logs and the page shows a fallback toast.

The event payload is a `JumpRequest`:

```ts
type JumpRequest = {
  id: string;            // "<file>:<line>"
  file: string;
  line: number;          // 1-based
  column: number;        // 1-based (1 when no range)
  range?: SgRange;
  editorUrl: string | null;
};
```

Listen from any host / userscript:

```js
window.addEventListener('scip-graph:jump', (e) => console.log(e.detail));
```

## Inbound — editor → view

### URL query

- `?focus=<file>:<line>` — reveal and highlight that node. It wins over `ids`.
- `?ids=<id>,<id>,…` — keep the existing multi-focus center set.
- `?id=<id>` — single-id alias.

The file/line form matches a node exactly; if there is no exact match the first
node in that file is used. Combined example:

```
/local?focus=src/lib/components/areas/CodeArea.svelte:115
/local?ids=src/lib/components/areas/CodeArea.svelte:86,src/lib/components/areas/CodeArea.svelte:115
```

### Window API

```js
window.__local_ready;                                  // true once mounted
window.__local.reveal('src/lib/…/CodeArea.svelte:115'); // by id or file:line
window.__local.reveal('src/lib/…/CodeArea.svelte');     // first node in file
window.__local.focus();                                 // current FocusInfo | null
window.__local.setFocus('src/lib/…/CodeArea.svelte:115'); // without re-centering
window.__local.setFocus(null);                          // clear
window.__local.editorUrl('src/lib/…/CodeArea.svelte:115'); // resolved URL | null
```

`reveal(target)` returns `boolean`; it re-centers on the node, highlights it,
scrolls it into view and toasts. `focus()` returns:

```ts
type FocusInfo = { uid; id; name; file; line; column };
```

### Window event

An editor can also dispatch:

```js
window.dispatchEvent(new CustomEvent('scip-graph:focus', {
  detail: { file: 'src/lib/components/areas/CodeArea.svelte', line: 115 }
  // or detail: 'src/lib/…/CodeArea.svelte:115'
  // or detail: { id: 'src/lib/…/CodeArea.svelte:115' }
}));
```

The listener is registered by the local view and routes to `reveal`.

## Reverse navigation recipes

- **VS Code task on save** — call `xdotool`/`code` with the URL, or open
  `http://localhost:8172/local?focus=${relativeFile}:${line}` in the browser.
- **Terminal / CLI** — print `scip-graph` output; use the `?focus=` URL.
- **Host app (Electron/Tauri)** — dispatch `scip-graph:focus` from the webview
  containing the viewer, or call `window.__local.reveal(...)` directly.

## Known limits

- `openInEditor` performs a best-effort `window.location.href = url`. Browsers
  may refuse to launch an unregistered custom scheme and simply keep the page;
  the toast/`editorUrl` still report the resolved URL.
- The env var is read from `$env/dynamic/public`, so a dev-server restart (not
  just an HMR reload) is required after changing it.
