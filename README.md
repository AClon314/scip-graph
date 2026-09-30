# scip-graph

Interactive viewer for a **SCIP-derived call graph**. A SCIP JSON index is
reduced to a compact graph of functions/methods/classes and their call edges,
served through a SvelteKit app with two complementary views:

- **Global** — density overview of the whole graph (find where code is dense or
  sparse, select a region).
- **Local** — butterfly view focused on one function or a set of functions:
  callers on the left, callees on the right.

> The canvas visualizations are not implemented yet — both routes currently
> render placeholder summaries (node / edge counts).

## Data model

The derive step emits the frozen `gpen-scip-graph/1` schema
(`src/lib/graph/schema.ts`):

```ts
type SgNode = { id, kind, name, file, line, weight, svelte, range? }
type SgEdge = { from, to, dispatch: 'static'|'virtual'|'self', confidence, calls, sites }
```

- `id` = `"<file>:<1-based line>"` (same key as Jelly / `func.json`).
- `weight` = degree (in + out, self loops counted once) — drives node size.
- `dispatch` = `virtual` when the callee is an interface / abstract member.
- `range` is optional and reserved for a future jump-to-source action
  (1-based line + column from the definition occurrence).

Edges are **scope-resolved**: SCIP `local N` symbols resolve within their own
document only.

## Develop

```sh
bun install
bun run dev
```

## Derive a graph

Port of `rules/scip/derive-graph.py` (same scoped-resolution rules and stats),
with `display_name` support and per-node `range`.

```sh
bun run derive -- --scip /path/to/index-fork.json --out static/graph.json
```

`static/graph.json` is gitignored. By default the app reads it from
`static/graph.json`; override the location with the `SCIP_GRAPH_FILE`
environment variable.

```sh
bun run derive --help
```

## Query CLI

The former `scip-graph-query.mjs` CLI now lives in this repo as strict
TypeScript under `src/lib/query/`, with the thin entrypoint
`src/bin/scip-graph.ts` (`bun run scip-graph`). It answers `callers` /
`callees` / `impact` (reachability), `refs` (call sites) and `boundaries`
(unresolved callees, read from the fork SCIP index). It reads
`static/graph.json` by default (`--graph` overrides); `boundaries` reads
`rules/out/.cache/scip/index-fork.json` by default (`--index` overrides).

```sh
bun run scip-graph -- callers "src/lib/components/areas/CodeArea.svelte:86" --json
bun run scip-graph -- refs "src/lib/components/areas/CodeArea.svelte:86"
bun run scip-graph -- impact "src/lib/components/areas/CodeArea.svelte:86" --depth 2 --format mermaid
bun run scip-graph -- boundaries --symbol '$state' --json
```

See [`docs/query-cli.md`](docs/query-cli.md) for selectors, the `--json`
contracts and exit codes, and [`docs/query-verification.md`](docs/query-verification.md)
for a verified transcript. Historical scip PoC docs live in [`docs/`](docs/README.md).

## Checks

```sh
bun run check   # svelte-kit sync + svelte-check
bun run build   # production build
```

## Layout

```
scripts/derive-graph.ts        # SCIP JSON index -> graph JSON (CLI)
src/lib/graph/schema.ts        # frozen graph types
src/lib/query/                 # scip-graph query library (select/reach/refs/boundaries/export)
src/bin/scip-graph.ts          # thin query CLI entrypoint
src/lib/server/loadGraph.ts    # server-side graph loader (SCIP_GRAPH_FILE)
src/routes/+layout.svelte      # nav: Global / Local
src/routes/global/             # global view
src/routes/local/              # local (butterfly) view
docs/                          # query CLI docs + historical scip PoCs
test/query.test.ts             # bun test for the query library
```
