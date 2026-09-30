/**
 * Pure model logic for the local butterfly view (faithful TS port of
 * `view-b/model.js`): ±N hop column expansion (N configurable, default 2),
 * multi-focus center set `S`
 * with union/dedupe + member annotations, option-driven pruning / pass-through
 * bypass, reachability, and sorting.
 *
 * Everything here is framework-free so it can be unit-tested independently of
 * canvas / DOM.
 */
import type { SgEdge, SgGraph, SgNode } from '$lib/graph/schema';

export type Side = 'left' | 'center' | 'right';
export type SortMode = 'alpha' | 'line' | 'mincross';
export type DispatchMode = 'all' | 'yes' | 'maybe' | 'no';

export type LocalOptions = {
	hideStdlib: boolean;
	hideUnreachable: boolean;
	collapsePassThrough: boolean;
	treeMode: boolean;
	perCallArrows: boolean;
	showFile: boolean;
	/** draw a semicircular hop where two bezier edges cross (visual only) */
	hops: boolean;
	dispatch: DispatchMode;
	sort: SortMode;
};

export const DEFAULT_OPTIONS: LocalOptions = {
	hideStdlib: false, // hide stdlib / external nodes (chain is bypassed)
	hideUnreachable: false, // hide nodes unreachable from S under the dispatch filter
	collapsePassThrough: false, // bypass nodes whose only callee is one function
	treeMode: false, // true = tree (duplicate a node per parent), false = graph (dedupe)
	perCallArrows: false, // one arrow per call site + line numbers
	showFile: false, // node content: name only vs name + file
	hops: false, // draw semicircular hops at visible edge crossings (visual only)
	dispatch: 'all', // all | yes (static+self) | maybe (virtual) | no
	sort: 'alpha' // alpha | line | mincross
};

export const SORT_MODES: SortMode[] = ['alpha', 'line', 'mincross'];
export const DISPATCH_MODES: DispatchMode[] = ['all', 'yes', 'maybe', 'no'];

/** Default number of caller/callee levels expanded on each side. */
export const DEFAULT_DEPTH = 2;

/** Coerce arbitrary input into a positive integer depth (>= 1). */
export function clampDepth(n: unknown): number {
	const v = typeof n === 'number' ? n : Number(n);
	if (!Number.isFinite(v)) return DEFAULT_DEPTH;
	return Math.max(1, Math.floor(v));
}

/** A column item (a visible node copy; duplicated in tree mode). */
export type LocalItem = {
	uid: string;
	id: string;
	node: SgNode;
	side: Side;
	depth: number;
	parentIds: string[];
	links: LocalLink[];
	innerRefs: LocalItem[];
	innerLines: number[];
	/** reachable from S under the current dispatch filter */
	unreachable: boolean;
	/** stdlib / node_modules / .d.ts / paraglide */
	external: boolean;
	/** min call-site line connecting this item inward (Infinity if none) */
	connectLine: number;
	/** which center member(s) this neighbour connects to */
	members: Set<string>;
	/** outermost item with hidden further neighbours (fading stub hint) */
	hasMore: boolean;
};

/** A drawn link between two visible items. */
export type LocalLink = {
	from: LocalItem;
	to: LocalItem;
	data: SgEdge;
	bridged: boolean;
	line: number;
	valid: boolean;
	internal: boolean;
};

export type LocalColumn = {
	key: string;
	side: Side;
	depth: number;
	label: string;
	items: LocalItem[];
};

export type LocalGraph = {
	nodes: SgNode[];
	edges: SgEdge[];
	nodesById: Map<string, SgNode>;
};

/** Build the lookup index once; the server hands us the raw frozen graph. */
export function buildGraphIndex(graph: SgGraph): LocalGraph {
	const nodesById = new Map<string, SgNode>();
	for (const n of graph.nodes) nodesById.set(n.id, n);
	return { nodes: graph.nodes, edges: graph.edges, nodesById };
}

const EXT_RE = /(^|\/)node_modules\/|\.d\.ts$/;

export function isExternal(node: SgNode | undefined | null): boolean {
	if (!node) return false;
	return EXT_RE.test(node.file) || node.file.startsWith('src/lib/paraglide/');
}

// Maps the ep04 yes/no/maybe taxonomy onto the frozen dispatch field:
//   static -> yes (definitely called), self -> yes (recursive),
//   virtual -> maybe (an interface/abstract member is invoked).
export function dispatchAllows(mode: DispatchMode, dispatch: SgEdge['dispatch']): boolean {
	switch (mode) {
		case 'all':
			return true;
		case 'yes':
			return dispatch === 'static' || dispatch === 'self';
		case 'maybe':
			return dispatch === 'virtual';
		case 'no':
			return false;
		default:
			return true;
	}
}

export function basename(file: string): string {
	const i = file.lastIndexOf('/');
	return i < 0 ? file : file.slice(i + 1);
}

function pairKey(a: string, b: string): string {
	return `${a}\u0000${b}`;
}

function buildPairMap(edges: SgEdge[]): Map<string, SgEdge[]> {
	const m = new Map<string, SgEdge[]>();
	for (const e of edges) {
		const k = pairKey(e.from, e.to);
		const arr = m.get(k);
		if (arr) arr.push(e);
		else m.set(k, [e]);
	}
	return m;
}

function addTo<T>(map: Map<T, Set<T>>, key: T, value: T): void {
	let s = map.get(key);
	if (!s) map.set(key, (s = new Set()));
	s.add(value);
}

// Collect neighbours of a frontier. dir='in' -> callers, dir='out' -> callees.
// Returns Map<neighbourId, Set<frontierId>>.
function neighborMap(
	edges: SgEdge[],
	frontierIds: string[],
	dir: 'in' | 'out',
	exclude?: Set<string>
): Map<string, Set<string>> {
	const res = new Map<string, Set<string>>();
	const fset = new Set(frontierIds);
	for (const e of edges) {
		const anchor = dir === 'in' ? e.to : e.from;
		const neighbour = dir === 'in' ? e.from : e.to;
		if (!fset.has(anchor)) continue;
		if (neighbour === anchor) continue; // self recursion is shown as an internal link
		if (exclude && exclude.has(neighbour)) continue;
		addTo(res, neighbour, anchor);
	}
	return res;
}

// BFS over the dispatch-filtered graph, both forward and backward from S.
export function computeReachable(
	graph: LocalGraph,
	centerSet: Set<string>,
	options: LocalOptions
): Set<string> {
	const out = new Map<string, Set<string>>();
	const inn = new Map<string, Set<string>>();
	for (const e of graph.edges) {
		if (e.from === e.to) continue;
		if (!dispatchAllows(options.dispatch, e.dispatch)) continue;
		addTo(out, e.from, e.to);
		addTo(inn, e.to, e.from);
	}
	const seen = new Set<string>(centerSet);
	const stack = [...centerSet];
	while (stack.length) {
		const x = stack.pop() as string;
		for (const y of out.get(x) || []) if (!seen.has(y)) (seen.add(y), stack.push(y));
		for (const y of inn.get(x) || []) if (!seen.has(y)) (seen.add(y), stack.push(y));
	}
	return seen;
}

function makeItem(
	uid: string,
	id: string,
	node: SgNode,
	side: Side,
	depth: number,
	parentIds: string[]
): LocalItem {
	return {
		uid,
		id,
		node,
		side,
		depth,
		parentIds,
		links: [],
		innerRefs: [],
		innerLines: [],
		unreachable: false,
		external: false,
		connectLine: Infinity,
		members: new Set(),
		hasMore: false
	};
}

function makeItems(
	map: Map<string, Set<string>>,
	key: string,
	side: Side,
	depth: number,
	graph: LocalGraph,
	options: LocalOptions
): LocalItem[] {
	const items: LocalItem[] = [];
	for (const [id, parents] of map) {
		const node = graph.nodesById.get(id);
		if (!node) continue;
		if (options.treeMode && parents.size >= 1) {
			// tree mode: one copy per distinct parent so branches don't rejoin
			for (const p of parents) {
				items.push(makeItem(`${key}\u0000${id}\u0000${p}`, id, node, side, depth, [p]));
			}
		} else {
			items.push(makeItem(`${key}\u0000${id}`, id, node, side, depth, [...parents]));
		}
	}
	return items;
}

type RawLink = { from: string; to: string; data: SgEdge; bridged?: boolean };

// Bypass pass-through / external nodes at the item (visible-column) level.
// Returns { edges, hidden:Set<uid> }. A bypassed node's callers are connected
// straight to its callees, so the chain is preserved without the node.
function bypassItems(
	columns: LocalColumn[],
	edges: RawLink[],
	options: LocalOptions
): { edges: RawLink[]; hidden: Set<string> } {
	if (!options.hideStdlib && !options.collapsePassThrough) {
		return { edges, hidden: new Set() };
	}
	let list = edges.slice();
	const hidden = new Set<string>();
	const itemByUid = new Map<string, LocalItem>();
	for (const col of columns) for (const it of col.items) itemByUid.set(it.uid, it);
	const centerCol = columns.find((c) => c.key === 'C');
	const centerUids = new Set((centerCol ? centerCol.items : []).map((i) => i.uid));

	const shouldPrune = (
		uid: string,
		outs: Map<string, Set<string>>,
		ins: Map<string, Set<string>>
	): boolean => {
		if (centerUids.has(uid) || hidden.has(uid)) return false;
		const it = itemByUid.get(uid);
		if (!it) return true;
		if (options.hideStdlib && isExternal(it.node)) return true;
		if (options.collapsePassThrough) {
			const oN = (outs.get(uid) || new Set()).size;
			const iN = (ins.get(uid) || new Set()).size;
			if (oN === 1 && iN >= 1) return true;
		}
		return false;
	};

	for (let iter = 0; iter < 500; iter++) {
		const outs = new Map<string, Set<string>>();
		const ins = new Map<string, Set<string>>();
		for (const e of list) {
			if (e.from === e.to) continue;
			addTo(outs, e.from, e.to);
			addTo(ins, e.to, e.from);
		}
		let victim: string | null = null;
		for (const uid of outs.keys()) if (shouldPrune(uid, outs, ins)) { victim = uid; break; }
		if (!victim) for (const uid of ins.keys()) if (shouldPrune(uid, outs, ins)) { victim = uid; break; }
		if (!victim) break;

		const incoming = list.filter((e) => e.to === victim && e.from !== victim);
		const outgoing = list.filter((e) => e.from === victim && e.to !== victim);
		list = list.filter((e) => e.from !== victim && e.to !== victim);
		hidden.add(victim);
		for (const i of incoming) {
			for (const o of outgoing) {
				if (i.from === o.to) continue;
				list.push({ from: i.from, to: o.to, data: o.data, bridged: true });
			}
		}
		if (list.length > 40000) break;
	}
	return { edges: list, hidden };
}

function linkLine(data: SgEdge): number {
	const sites = data && data.sites;
	if (!sites || !sites.length) return Infinity;
	let min = Infinity;
	for (const s of sites) if (s.line < min) min = s.line;
	return min;
}

export type ExpandResult = {
	columns: LocalColumn[];
	edges: LocalLink[];
	reachable: Set<string>;
	centerIds: string[];
};

// Expand the butterfly for a center set S.
export function expand(
	graph: LocalGraph,
	centerIds: string[],
	options: LocalOptions,
	depth: number = DEFAULT_DEPTH
): ExpandResult {
	const levels = clampDepth(depth);
	const centerSet = new Set(centerIds.filter((id) => graph.nodesById.has(id)));
	const centerList = [...centerSet];
	const reachable = computeReachable(graph, centerSet, options);

	// neighbour sets for the fading "hidden neighbour" hints, built from the raw
	// edge list so the model does not depend on any pre-built index.
	const inAdj = new Map<string, Set<string>>();
	const outAdj = new Map<string, Set<string>>();
	for (const e of graph.edges) {
		if (e.from === e.to) continue;
		addTo(outAdj, e.from, e.to);
		addTo(inAdj, e.to, e.from);
	}

	// 1. raw ±N neighbourhood from the original graph (grandparents, not
	// siblings). Each level excludes every node already seen at a nearer level,
	// so a node only appears in the closest column that reaches it (dedupe).
	// Expansion terminates early once a level reaches no new nodes.
	const leftMaps: Array<Map<string, Set<string>>> = [];
	const rightMaps: Array<Map<string, Set<string>>> = [];
	let seenL = new Set<string>(centerSet);
	let frontierL = centerList;
	for (let d = 1; d <= levels; d++) {
		const m = neighborMap(graph.edges, frontierL, 'in', seenL);
		leftMaps.push(m);
		if (!m.size) break;
		for (const id of m.keys()) seenL.add(id);
		frontierL = [...m.keys()];
	}
	let seenR = new Set<string>(centerSet);
	let frontierR = centerList;
	for (let d = 1; d <= levels; d++) {
		const m = neighborMap(graph.edges, frontierR, 'out', seenR);
		rightMaps.push(m);
		if (!m.size) break;
		for (const id of m.keys()) seenR.add(id);
		frontierR = [...m.keys()];
	}

	// 2. materialise columns: deepest left first … centre … deepest right last
	const labelFor = (side: Side, d: number): string =>
		side === 'left' ? (d === 1 ? 'callers' : `ancestors ${d}`) : d === 1 ? 'callees' : `descendants ${d}`;
	const columns: LocalColumn[] = [];
	for (let d = leftMaps.length; d >= 1; d--) {
		columns.push({
			key: `L${d}`,
			side: 'left',
			depth: d,
			label: labelFor('left', d),
			items: makeItems(leftMaps[d - 1], `L${d}`, 'left', d, graph, options)
		});
	}
	columns.push({
		key: 'C',
		side: 'center',
		depth: 0,
		label: 'focus',
		items: makeItems(new Map(centerList.map((id) => [id, new Set<string>()])), 'C', 'center', 0, graph, options)
	});
	for (let d = 1; d <= rightMaps.length; d++) {
		columns.push({
			key: `R${d}`,
			side: 'right',
			depth: d,
			label: labelFor('right', d),
			items: makeItems(rightMaps[d - 1], `R${d}`, 'right', d, graph, options)
		});
	}
	const leftOuter = leftMaps.length;
	const rightOuter = rightMaps.length;

	// 3. item-level edges between adjacent columns + intra-center links
	const pairMap = buildPairMap(graph.edges);
	let edges: RawLink[] = [];
	const wire = (a: LocalItem, b: LocalItem): void => {
		const found = pairMap.get(pairKey(a.id, b.id));
		if (!found) return;
		for (const e of found) edges.push({ from: a.uid, to: b.uid, data: e, bridged: false });
	};
	for (let i = 0; i < columns.length - 1; i++) {
		for (const a of columns[i].items) for (const b of columns[i + 1].items) wire(a, b);
	}
	const centerCol = columns.find((c) => c.key === 'C') as LocalColumn;
	for (const a of centerCol.items) for (const b of centerCol.items) if (a !== b) wire(a, b);

	// 4. bypass pass-through / external nodes
	const bypass = bypassItems(columns, edges, options);
	edges = bypass.edges;
	if (bypass.hidden.size) {
		for (const col of columns) col.items = col.items.filter((it) => !bypass.hidden.has(it.uid));
	}

	// 5. hide unreachable
	if (options.hideUnreachable) {
		for (const col of columns) {
			if (col.key === 'C') continue;
			col.items = col.items.filter((it) => reachable.has(it.id));
		}
	}

	// 6. annotate items and links
	const itemByUid = new Map<string, LocalItem>();
	for (const col of columns) {
		for (const it of col.items) {
			it.links = [];
			it.innerRefs = [];
			it.innerLines = [];
			itemByUid.set(it.uid, it);
		}
	}
	const kept: LocalLink[] = [];
	for (const e of edges) {
		const a = itemByUid.get(e.from);
		const b = itemByUid.get(e.to);
		if (!a || !b) continue;
		const rec: LocalLink = {
			from: a,
			to: b,
			data: e.data,
			bridged: !!e.bridged,
			line: linkLine(e.data),
			valid: dispatchAllows(options.dispatch, e.data.dispatch),
			internal: a.side === 'center' && b.side === 'center'
		};
		kept.push(rec);
		a.links.push(rec);
		b.links.push(rec);
		if (a.side === 'left') {
			a.innerRefs.push(b);
			a.innerLines.push(rec.line);
		}
		if (b.side === 'right') {
			b.innerRefs.push(a);
			b.innerLines.push(rec.line);
		}
	}
	// 7. per-item metadata: reachability, member set (multi-focus annotation),
	//    connect line (sorting), hidden-neighbour hint (fading stubs).
	for (const col of columns) {
		for (const it of col.items) {
			it.unreachable = !reachable.has(it.id);
			it.external = isExternal(it.node);
			it.connectLine =
				it.side === 'center'
					? it.node.line
					: it.innerLines.length
						? Math.min(...it.innerLines)
						: Infinity;
			it.innerRefs = [...new Set(it.innerRefs)];
		}
	}

	const displayedIds = new Set<string>();
	for (const col of columns) for (const it of col.items) displayedIds.add(it.id);

	const membersOf = (start: LocalItem): Set<string> => {
		const out = new Set<string>();
		const seen = new Set<string>([start.uid]);
		const stack: LocalItem[] = [start];
		while (stack.length) {
			const it = stack.pop() as LocalItem;
			for (const ref of it.innerRefs) {
				if (ref === start) continue;
				if (ref.side === 'center') out.add(ref.id);
				else if (!seen.has(ref.uid)) (seen.add(ref.uid), stack.push(ref));
			}
		}
		return out;
	};
	for (const col of columns) {
		for (const it of col.items) {
			if (it.side === 'center') {
				it.members = new Set(
					it.links.filter((l) => l.internal).map((l) => (l.from === it ? l.to.id : l.from.id))
				);
			} else {
				it.members = membersOf(it);
			}
			const isOuter =
				(it.side === 'left' && it.depth === leftOuter) ||
				(it.side === 'right' && it.depth === rightOuter);
			if (isOuter) {
				const neighbours = it.side === 'left' ? inAdj.get(it.id) : outAdj.get(it.id);
				it.hasMore = !!neighbours && [...neighbours].some((other) => !displayedIds.has(other));
			} else {
				it.hasMore = false;
			}
		}
	}

	return { columns, edges: kept, reachable, centerIds: centerList };
}

function median(values: number[]): number {
	if (!values.length) return Infinity;
	const s = values.slice().sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function byName(a: LocalItem, b: LocalItem): number {
	return a.node.name.localeCompare(b.node.name) || a.id.localeCompare(b.id);
}

function byLine(a: LocalItem, b: LocalItem): number {
	const d = (a.connectLine ?? Infinity) - (b.connectLine ?? Infinity);
	return d !== 0 ? d : byName(a, b);
}

// 2-layer median heuristic: order each outer column by the median index of its
// neighbours in the already-ordered inner column; sweep a few times.
function minCrossing(columns: LocalColumn[]): void {
	const col: Record<string, LocalColumn> = Object.fromEntries(columns.map((c) => [c.key, c]));
	if (col.C) col.C.items.sort(byName);
	const sequence: Array<[string, string]> = [];
	let maxLeft = 0;
	let maxRight = 0;
	for (const c of columns) {
		if (c.side === 'left' && c.depth > maxLeft) maxLeft = c.depth;
		if (c.side === 'right' && c.depth > maxRight) maxRight = c.depth;
	}
	for (let d = 1; d <= maxLeft; d++) sequence.push([`L${d}`, d === 1 ? 'C' : `L${d - 1}`]);
	for (let d = 1; d <= maxRight; d++) sequence.push([`R${d}`, d === 1 ? 'C' : `R${d - 1}`]);
	for (let iter = 0; iter < 4; iter++) {
		for (const [outerKey, innerKey] of sequence) {
			const inner = col[innerKey];
			const outer = col[outerKey];
			if (!inner || !outer) continue;
			const idx = new Map(inner.items.map((it, i) => [it.uid, i]));
			const scored = outer.items.map((it) => {
				const ns = it.innerRefs.map((r) => idx.get(r.uid)).filter((v): v is number => v !== undefined);
				return { it, m: median(ns) };
			});
			scored.sort((a, b) => a.m - b.m || byName(a.it, b.it));
			outer.items = scored.map((s) => s.it);
		}
	}
}

export function sortColumns(columns: LocalColumn[], options: LocalOptions): LocalColumn[] {
	if (options.sort === 'alpha') {
		for (const col of columns) col.items.sort(byName);
	} else if (options.sort === 'line') {
		for (const col of columns) col.items.sort(byLine);
	} else {
		minCrossing(columns);
	}
	return columns;
}

export type ColumnsState = {
	left: string[];
	right: string[];
	/** per-level ids, index 0 = L1/R1 (nearest the centre) */
	leftLevels: string[][];
	rightLevels: string[][];
	left1: string[];
	left2: string[];
	right1: string[];
	right2: string[];
};

// Convenience projection for window.__local.state(). Levels are ascending from
// the centre (L1 nearest). `left1`/`left2` etc. are kept for compatibility.
export function columnsState(columns: LocalColumn[]): ColumnsState {
	const levels = (side: Side): string[][] =>
		columns
			.filter((c) => c.side === side && c.depth > 0)
			.sort((a, b) => a.depth - b.depth)
			.map((c) => [...new Set(c.items.map((i) => i.id))]);
	const leftLevels = levels('left');
	const rightLevels = levels('right');
	return {
		left: [...new Set(leftLevels.flat())],
		right: [...new Set(rightLevels.flat())],
		leftLevels,
		rightLevels,
		left1: leftLevels[0] ?? [],
		left2: leftLevels[1] ?? [],
		right1: rightLevels[0] ?? [],
		right2: rightLevels[1] ?? []
	};
}
