/**
 * Canvas 2D renderer for the butterfly view (faithful TS port of
 * `view-b/render.js`): columns of nodes, per-layer independent smooth scroll,
 * bezier links with fading arrowheads, clickable nodes. The centre column never
 * scrolls vertically; the whole column strip can pan horizontally when the
 * dynamic ±N depth makes it wider than the viewport.
 */
import type { LocalColumn, LocalItem, LocalLink, LocalOptions } from '$lib/local/model';

type ColumnData = { columns: LocalColumn[]; edges: LocalLink[] };

export type RendererHandlers = {
	onClick?: (item: LocalItem, ev: MouseEvent, info: { plus: boolean }) => void;
	onHover?: (item: LocalItem | null, info: { plus: boolean }) => void;
	onBackground?: () => void;
};

export type HitResult = { item: LocalItem; column: LocalColumn; box: Box };

/** Focus ring target, surfaced through `window.__local.focus()`. */
export type FocusInfo = {
	uid: string;
	id: string;
	name: string;
	file: string;
	line: number;
	column: string;
};

type Box = { it: LocalItem; x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };
type Geo = {
	col: LocalColumn;
	x: number;
	w: number;
	h: number;
	rowGap: number;
	scale: number;
	step: number;
	contentH: number;
	availH: number;
	boxes: Box[];
};

const BASE_W = 214;
const BASE_H = 58;
const ROW_GAP = 16;
const GAP_X = 104;
const CONTENT_TOP = 58;
const CONTENT_BOTTOM = 34;

// Horizontal strip scrolling (only active when the columns overflow).
const STRIP_MARGIN = 24;
const HSCROLL_H = 6;
const HSCROLL_MARGIN = 44;
const HSCROLL_BOTTOM = 16;

// Deeper columns shrink gently; never below half size.
const DEPTH_SCALE_MIN = 0.5;
function depthScale(depth: number): number {
	return Math.max(DEPTH_SCALE_MIN, 1 - 0.17 * depth);
}

// Crossing hops (visual only). Sample the drawn beziers, find crossings, then
// bridge one edge of each crossing with a near-semicircle bump.
const HOP_SAMPLES = 16;
const HOP_DRAW_SAMPLES = 32;
const HOP_BRIDGE = 9;
const HOP_MIN_T = 0.06;

const COLORS = {
	bg: '#0e1116',
	header: '#8ea0b8',
	headerLine: '#26303d',
	nodeLeft: '#1b2634',
	nodeRight: '#1b2a24',
	nodeCenter: '#2b2138',
	nodeStroke: '#3c4c62',
	centerStroke: '#b98cff',
	focusRing: '#ffd479',
	text: '#dbe4f0',
	muted: '#7f8fa4',
	hover: '#f4f8ff',
	unreachable: '#6a7484',
	edgeStatic: [126, 174, 236] as [number, number, number],
	edgeVirtual: [240, 178, 92] as [number, number, number],
	edgeSelf: [136, 220, 164] as [number, number, number]
};

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(hi, Math.max(lo, v));
}

function edgeRGB(dispatch: string): [number, number, number] {
	if (dispatch === 'virtual') return COLORS.edgeVirtual;
	if (dispatch === 'self') return COLORS.edgeSelf;
	return COLORS.edgeStatic;
}

function rgba(rgb: [number, number, number], a: number): string {
	return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
}

export type Renderer = ReturnType<typeof createRenderer>;

export function createRenderer(
	canvas: HTMLCanvasElement,
	getColumns: () => LocalColumn[],
	getOptions: () => LocalOptions
) {
	const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
	const scroll = new Map<string, { inst: number; smooth: number; max: number }>();
	let handlers: RendererHandlers = {};
	let data: ColumnData = { columns: [], edges: [] };
	let zoom = 0.92;
	let zoomTarget = 0.92;
	let hoverUid: string | null = null;
	let hoverPlus = false;
	let focusUid: string | null = null;
	let lastHopCount = 0;
	let cssW = 1;
	let cssH = 1;
	let raf: number | null = null;
	let lastT = 0;
	let lastGeo: Geo[] = [];
	let panInst = 0;
	let panSmooth = 0;
	let lastStrip: Strip | null = null;

	type Strip = {
		left0: number;
		right0: number;
		contentW: number;
		minPan: number;
		maxPan: number;
		fits: boolean;
		trackX: number;
		trackW: number;
		thumbW: number;
	};

	type Drag = { mode: 'pan' | 'thumb'; startX: number; startPan: number; moved: boolean };
	let drag: Drag | null = null;
	let suppressClick = false;

	function getScroll(key: string): { inst: number; smooth: number; max: number } {
		let s = scroll.get(key);
		if (!s) scroll.set(key, (s = { inst: 0, smooth: 0, max: 0 }));
		return s;
	}

	function dimsFor(depth: number): { w: number; h: number; rowGap: number; scale: number } {
		const s = zoom * depthScale(depth);
		return { w: BASE_W * s, h: BASE_H * s, rowGap: ROW_GAP * s, scale: s };
	}

	function resize(): void {
		const dpr = window.devicePixelRatio || 1;
		cssW = canvas.clientWidth || 1;
		cssH = canvas.clientHeight || 1;
		canvas.width = Math.max(1, Math.round(cssW * dpr));
		canvas.height = Math.max(1, Math.round(cssH * dpr));
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	function layout(): Geo[] {
		const byKey = new Map(data.columns.map((c) => [c.key, c]));
		const geo: Geo[] = [];
		const center = byKey.get('C');
		if (!center) return geo;
		const cd = dimsFor(0);
		const centerX = cssW / 2 - cd.w / 2;
		const gap = GAP_X * zoom + 26;

		const rightCols = data.columns.filter((c) => c.side === 'right').sort((a, b) => a.depth - b.depth);
		const leftCols = data.columns.filter((c) => c.side === 'left').sort((a, b) => a.depth - b.depth);

		let x = centerX + cd.w + gap;
		const right: Geo[] = [];
		for (const col of rightCols) {
			const d = dimsFor(col.depth);
			right.push({ col, x, ...d, boxes: [], step: 0, contentH: 0, availH: 0 });
			x += d.w + gap;
		}
		let lx = centerX - gap;
		const left: Geo[] = [];
		for (const col of leftCols) {
			const d = dimsFor(col.depth);
			left.push({ col, x: lx - d.w, ...d, boxes: [], step: 0, contentH: 0, availH: 0 });
			lx = lx - d.w - gap;
		}
		// visual order: deepest-left … L1, C, R1 … deepest-right
		geo.push(
			...left.reverse(),
			{ col: center, x: centerX, ...cd, boxes: [], step: 0, contentH: 0, availH: 0 },
			...right
		);

		// --- horizontal strip / pan clamp -----------------------------------
		let left0 = Infinity;
		let right0 = -Infinity;
		for (const g of geo) {
			left0 = Math.min(left0, g.x);
			right0 = Math.max(right0, g.x + g.w);
		}
		if (!Number.isFinite(left0)) {
			left0 = 0;
			right0 = cssW;
		}
		const contentW = Math.max(1, right0 - left0);
		// A couple of px of slack; the strip only scrolls when it truly overflows.
		const fits = contentW <= cssW - 2;
		let minPan = 0;
		let maxPan = 0;
		if (fits) {
			// centre stays anchored when the whole strip fits
			panInst = 0;
			panSmooth = 0;
		} else {
			// maxPan reveals the leftmost column, minPan the rightmost
			maxPan = STRIP_MARGIN - left0;
			minPan = cssW - STRIP_MARGIN - right0;
			panInst = clamp(panInst, minPan, maxPan);
			panSmooth = clamp(panSmooth, minPan, maxPan);
		}
		const trackX = HSCROLL_MARGIN;
		const trackW = Math.max(1, cssW - HSCROLL_MARGIN * 2);
		const thumbW = fits ? trackW : Math.max(36, Math.min(trackW, trackW * (cssW / contentW)));
		lastStrip = { left0, right0, contentW, minPan, maxPan, fits, trackX, trackW, thumbW };

		const pan = fits ? 0 : panSmooth;
		if (pan) for (const g of geo) g.x += pan;

		const availH = Math.max(60, cssH - CONTENT_TOP - CONTENT_BOTTOM);
		for (const g of geo) {
			const step = g.h + g.rowGap;
			const contentH = Math.max(0, g.col.items.length * step - g.rowGap);
			let startY: number;
			if (g.col.key === 'C') {
				startY = CONTENT_TOP + Math.max(0, (availH - contentH) / 2);
				getScroll(g.col.key).max = 0;
			} else {
				const s = getScroll(g.col.key);
				const max = Math.max(0, contentH - availH);
				s.max = max;
				s.inst = clamp(s.inst, 0, max);
				s.smooth = clamp(s.smooth, 0, max);
				startY = CONTENT_TOP - s.smooth;
			}
			g.step = step;
			g.contentH = contentH;
			g.availH = availH;
			g.boxes = g.col.items.map((it, i) => ({ it, x: g.x, y: startY + i * step, w: g.w, h: g.h }));
		}
		lastGeo = geo;
		return geo;
	}

	// Deepest visible column key on each side (for the fading "more" stubs).
	function outerKeys(): { left: string | null; right: string | null } {
		let l = 0;
		let r = 0;
		for (const c of data.columns) {
			if (c.side === 'left' && c.depth > l) l = c.depth;
			if (c.side === 'right' && c.depth > r) r = c.depth;
		}
		return { left: l ? `L${l}` : null, right: r ? `R${r}` : null };
	}

	function boxMap(geo: Geo[]): Map<string, Box> {
		const m = new Map<string, Box>();
		for (const g of geo) for (const b of g.boxes) m.set(b.it.uid, b);
		return m;
	}

	function fitText(text: string, maxWidth: number): string {
		if (ctx.measureText(text).width <= maxWidth) return text;
		let lo = 0;
		let hi = text.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxWidth) lo = mid + 1;
			else hi = mid;
		}
		return `${text.slice(0, Math.max(1, lo - 1))}…`;
	}

	function roundRect(x: number, y: number, w: number, h: number, r: number): void {
		ctx.beginPath();
		ctx.moveTo(x + r, y);
		ctx.arcTo(x + w, y, x + w, y + h, r);
		ctx.arcTo(x + w, y + h, x, y + h, r);
		ctx.arcTo(x, y + h, x, y, r);
		ctx.arcTo(x, y, x + w, y, r);
		ctx.closePath();
	}

	function arrowHead(x: number, y: number, tx: number, ty: number, size: number, alpha: number): void {
		const len = Math.hypot(tx, ty) || 1;
		const ux = tx / len;
		const uy = ty / len;
		const px = -uy;
		const py = ux;
		ctx.beginPath();
		ctx.moveTo(x, y);
		ctx.lineTo(x - ux * size + px * size * 0.55, y - uy * size + py * size * 0.55);
		ctx.lineTo(x - ux * size - px * size * 0.55, y - uy * size - py * size * 0.55);
		ctx.closePath();
		ctx.globalAlpha = alpha;
		ctx.fill();
	}

	type Path = { p0: Pt; p1: Pt; p2: Pt; p3: Pt; internal: boolean };

	function edgePath(rec: LocalLink, boxes: Map<string, Box>): Path | null {
		const a = boxes.get(rec.from.uid);
		const b = boxes.get(rec.to.uid);
		if (!a || !b) return null;
		const p0 = { x: a.x + a.w, y: a.y + a.h / 2 };
		const p3 = rec.internal ? { x: b.x + b.w, y: b.y + b.h / 2 } : { x: b.x, y: b.y + b.h / 2 };
		const dx = rec.internal ? 52 * zoom : Math.max(22, Math.abs(p3.x - p0.x) * 0.42);
		return {
			p0,
			p1: { x: p0.x + dx, y: p0.y },
			p2: { x: rec.internal ? p3.x + dx : p3.x - dx, y: p3.y },
			p3,
			internal: rec.internal
		};
	}

	function bezierAt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
		const u = 1 - t;
		const a = u * u * u;
		const b = 3 * u * u * t;
		const c = 3 * u * t * t;
		const d = t * t * t;
		return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
	}

	function samplePath(path: Path, n: number, off = 0): Pt[] {
		const pts: Pt[] = [];
		for (let i = 0; i <= n; i++) {
			const pt = bezierAt(path.p0, path.p1, path.p2, path.p3, i / n);
			pts.push({ x: pt.x, y: pt.y + off });
		}
		return pts;
	}

	// Bridge the hopping curve over a crossing with a near-semicircle bump.
	// `a` is the current point; the cubic bulges to the smaller-y side.
	function drawBump(a: Pt, b: Pt): void {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len = Math.hypot(dx, dy) || 1;
		let nx = -dy / len;
		let ny = dx / len;
		if (ny > 0) {
			nx = -nx;
			ny = -ny;
		}
		const k = (2 / 3) * len;
		ctx.bezierCurveTo(a.x + nx * k, a.y + ny * k, b.x + nx * k, b.y + ny * k, b.x, b.y);
	}

	// Draw a sampled bezier as a polyline, replacing each hop with a bump.
	function strokePathWithHops(pts: Pt[], ts: number[]): void {
		const n = pts.length;
		let pathLen = 0;
		for (let i = 1; i < n; i++) pathLen += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
		const segLen = pathLen / Math.max(1, n - 1) || 1;
		const w = clamp(Math.round(HOP_BRIDGE / segLen), 1, 8);
		const idxs = [...new Set(ts.map((t) => clamp(Math.round(t * (n - 1)), 1, n - 2)))].sort((a, b) => a - b);
		ctx.beginPath();
		ctx.moveTo(pts[0].x, pts[0].y);
		let cur = 0;
		for (const k of idxs) {
			const a = Math.max(cur, k - w);
			const b = Math.min(n - 1, k + w);
			if (b <= a) continue;
			for (let i = cur + 1; i <= a; i++) ctx.lineTo(pts[i].x, pts[i].y);
			drawBump(pts[a], pts[b]);
			cur = b;
		}
		for (let i = cur + 1; i < n; i++) ctx.lineTo(pts[i].x, pts[i].y);
		ctx.stroke();
	}

	function segIntersect(a: Pt, b: Pt, c: Pt, d: Pt): { t: number; u: number; x: number; y: number } | null {
		const rx = b.x - a.x;
		const ry = b.y - a.y;
		const sx = d.x - c.x;
		const sy = d.y - c.y;
		const denom = rx * sy - ry * sx;
		if (Math.abs(denom) < 1e-9) return null;
		const qx = c.x - a.x;
		const qy = c.y - a.y;
		const t = (qx * sy - qy * sx) / denom;
		const u = (qx * ry - qy * rx) / denom;
		if (t < 0 || t > 1 || u < 0 || u > 1) return null;
		return { t, u, x: a.x + t * rx, y: a.y + t * ry };
	}

	type HopRec = { rec: LocalLink; pts: Pt[]; minX: number; minY: number; maxX: number; maxY: number };

	// Pure visual crossing detection on the drawn geometry. Samples every
	// non-internal bezier, then marks the later-drawn edge of each crossing
	// pair to hop over. Never feeds back into layout or metrics.
	function computeHops(edges: LocalLink[], boxes: Map<string, Box>): Map<string, number[]> {
		const out = new Map<string, number[]>();
		const recs: HopRec[] = [];
		for (const rec of edges) {
			if (rec.internal) continue; // self-loops near the centre are left alone
			const path = edgePath(rec, boxes);
			if (!path) continue;
			const pts = samplePath(path, HOP_SAMPLES);
			let minX = Infinity;
			let minY = Infinity;
			let maxX = -Infinity;
			let maxY = -Infinity;
			for (const p of pts) {
				if (p.x < minX) minX = p.x;
				if (p.x > maxX) maxX = p.x;
				if (p.y < minY) minY = p.y;
				if (p.y > maxY) maxY = p.y;
			}
			recs.push({ rec, pts, minX, minY, maxX, maxY });
		}
		for (let i = 0; i < recs.length; i++) {
			for (let j = i + 1; j < recs.length; j++) {
				const a = recs[i];
				const b = recs[j];
				// edges sharing a node fan out from/to it; they do not cross there.
				if (
					a.rec.from.uid === b.rec.from.uid ||
					a.rec.to.uid === b.rec.to.uid ||
					a.rec.from.uid === b.rec.to.uid ||
					a.rec.to.uid === b.rec.from.uid
				)
					continue;
				if (a.maxX < b.minX || b.maxX < a.minX || a.maxY < b.minY || b.maxY < a.minY) continue;
				let found: number | null = null;
				for (let si = 0; si < HOP_SAMPLES && found === null; si++) {
					for (let sj = 0; sj < HOP_SAMPLES && found === null; sj++) {
						const hit = segIntersect(a.pts[si], a.pts[si + 1], b.pts[sj], b.pts[sj + 1]);
						if (!hit) continue;
						const ti = (si + hit.t) / HOP_SAMPLES;
						const tj = (sj + hit.u) / HOP_SAMPLES;
						if (ti < HOP_MIN_T || ti > 1 - HOP_MIN_T || tj < HOP_MIN_T || tj > 1 - HOP_MIN_T) continue;
						found = tj;
					}
				}
				if (found === null) continue;
				const uid = b.rec.from.uid;
				let arr = out.get(uid);
				if (!arr) out.set(uid, (arr = []));
				if (!arr.some((t) => Math.abs(t - found!) < 0.02)) arr.push(found);
			}
		}
		return out;
	}

	function drawEdge(rec: LocalLink, boxes: Map<string, Box>, opts: LocalOptions, hops: number[] | null): void {
		const path = edgePath(rec, boxes);
		if (!path) return;
		const { p0, p1, p2, p3 } = path;
		const rgb = edgeRGB(rec.data.dispatch);
		const depth = Math.max(rec.from.depth, rec.to.depth);
		let alpha = depth >= 2 ? 0.26 : depth === 1 ? 0.5 : 0.72;
		if (!rec.valid) alpha = 0.1;

		ctx.save();
		ctx.strokeStyle = rgba(rgb, alpha);
		ctx.lineWidth = rec.bridged ? 1.1 : 1.6;
		if (!rec.valid) ctx.setLineDash([4, 5]);
		if (rec.bridged) ctx.setLineDash([7, 4]);

		const calls =
			opts.perCallArrows && rec.data.sites && rec.data.sites.length > 1 ? rec.data.sites.length : 1;
		for (let k = 0; k < calls; k++) {
			const off = calls > 1 ? (k - (calls - 1) / 2) * 5 : 0;
			if (hops && hops.length) {
				strokePathWithHops(samplePath(path, HOP_DRAW_SAMPLES, off), hops);
			} else {
				ctx.beginPath();
				ctx.moveTo(p0.x, p0.y + off);
				ctx.bezierCurveTo(p1.x, p1.y + off, p2.x, p2.y + off, p3.x, p3.y + off);
				ctx.stroke();
			}
		}
		ctx.setLineDash([]);
		arrowHead(p3.x, p3.y, p3.x - p2.x, p3.y - p2.y, 8, alpha + 0.08);

		if (opts.perCallArrows && rec.line !== Infinity && calls === 1) {
			ctx.globalAlpha = alpha + 0.2;
			ctx.fillStyle = COLORS.muted;
			ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(String(rec.line), (p0.x + p3.x) / 2, (p0.y + p3.y) / 2 - 8);
			ctx.textAlign = 'left';
		}
		ctx.restore();
	}

	function drawStub(box: Box, dir: 'left' | 'right', alpha: number): void {
		const cy = box.y + box.h / 2;
		const from = dir === 'left' ? { x: box.x - 46, y: cy } : { x: box.x + box.w + 46, y: cy };
		const to = dir === 'left' ? { x: box.x, y: cy } : { x: box.x + box.w, y: cy };
		const grad = ctx.createLinearGradient(from.x, 0, to.x, 0);
		grad.addColorStop(dir === 'left' ? 0 : 1, 'rgba(126,174,236,0)');
		grad.addColorStop(dir === 'left' ? 1 : 0, `rgba(126,174,236,${alpha})`);
		ctx.save();
		ctx.strokeStyle = grad;
		ctx.lineWidth = 1.4;
		ctx.beginPath();
		ctx.moveTo(from.x, from.y);
		ctx.lineTo(to.x, to.y);
		ctx.stroke();
		const tx = dir === 'left' ? 1 : -1;
		ctx.globalAlpha = alpha;
		ctx.fillStyle = 'rgba(126,174,236,1)';
		arrowHead(to.x, to.y, tx, 0, 7, alpha);
		ctx.restore();
	}

	function drawNode(box: Box, col: LocalColumn, opts: LocalOptions, isHover: boolean, isFocus = false): void {
		const it = box.it;
		const s = box.h / BASE_H;
		const isCenter = col.key === 'C';
		const fill = isCenter ? COLORS.nodeCenter : col.side === 'left' ? COLORS.nodeLeft : COLORS.nodeRight;
		const stroke = isCenter ? COLORS.centerStroke : COLORS.nodeStroke;
		ctx.save();
		ctx.globalAlpha = it.unreachable ? 0.42 : 1;
		roundRect(box.x, box.y, box.w, box.h, 8 * s);
		ctx.fillStyle = fill;
		ctx.fill();
		ctx.lineWidth = isHover ? 2 : 1.2;
		ctx.strokeStyle = isHover ? COLORS.hover : stroke;
		if (it.external) ctx.setLineDash([5, 4]);
		ctx.stroke();
		ctx.setLineDash([]);

		if (isFocus) {
			ctx.save();
			ctx.globalAlpha = 1;
			ctx.lineWidth = 2;
			ctx.strokeStyle = COLORS.focusRing;
			roundRect(box.x - 2.5, box.y - 2.5, box.w + 5, box.h + 5, 8 * s + 2.5);
			ctx.stroke();
			ctx.restore();
		}

		const pad = 9 * s;
		const nameSize = Math.max(9, Math.round(13 * s));
		const text = fitText(it.node.name, box.w - pad * 2 - (it.members && it.members.size > 1 ? 22 : 0));
		ctx.fillStyle = isCenter ? '#efe6ff' : COLORS.text;
		ctx.font = `600 ${nameSize}px ui-sans-serif, system-ui, sans-serif`;
		ctx.textBaseline = 'alphabetic';
		const showFile = opts.showFile;
		const nameY = box.y + (showFile ? box.h * 0.38 : box.h / 2 + nameSize * 0.34);
		ctx.fillText(text, box.x + pad, nameY);

		if (showFile) {
			ctx.fillStyle = COLORS.muted;
			ctx.font = `${Math.max(8, Math.round(10 * s))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
			ctx.fillText(fitText(it.node.file, box.w - pad * 2), box.x + pad, box.y + box.h * 0.74);
		}

		if (it.members && it.members.size > 1 && !isCenter) {
			const badge = `×${it.members.size}`;
			ctx.font = `700 ${Math.max(8, Math.round(10 * s))}px ui-sans-serif, system-ui, sans-serif`;
			const bw = ctx.measureText(badge).width + 8;
			roundRect(box.x + box.w - bw - 5, box.y + 4, bw, 14 * s, 5);
			ctx.fillStyle = 'rgba(185,140,255,0.22)';
			ctx.fill();
			ctx.fillStyle = '#cbb6ff';
			ctx.fillText(badge, box.x + box.w - bw - 1, box.y + 4 + 11 * s);
		}

		if (it.unreachable) {
			ctx.fillStyle = COLORS.unreachable;
			ctx.font = '9px ui-sans-serif, system-ui, sans-serif';
			ctx.fillText('unreachable', box.x + box.w - 62 * s, box.y + box.h - 6 * s);
		}

		if (isHover && !isCenter) {
			const pr = 13;
			const px = box.x + box.w - pr - 3;
			const py = box.y + box.h - pr - 3;
			roundRect(px, py, pr, pr, 4);
			ctx.fillStyle = 'rgba(255,255,255,0.12)';
			ctx.fill();
			ctx.strokeStyle = COLORS.hover;
			ctx.beginPath();
			ctx.moveTo(px + pr / 2, py + 3.5);
			ctx.lineTo(px + pr / 2, py + pr - 3.5);
			ctx.moveTo(px + 3.5, py + pr / 2);
			ctx.lineTo(px + pr - 3.5, py + pr / 2);
			ctx.stroke();
		}
		ctx.restore();
	}

	function drawScrollbar(g: Geo): void {
		const s = getScroll(g.col.key);
		if (s.max <= 0) return;
		const trackX = g.col.side === 'left' ? g.x - 10 : g.x + g.w + 4;
		const trackY = CONTENT_TOP;
		const trackH = g.availH;
		const thumbH = Math.max(28, (trackH * trackH) / (g.contentH || trackH));
		const t = s.inst / s.max;
		const thumbY = trackY + t * (trackH - thumbH);
		ctx.save();
		ctx.fillStyle = 'rgba(255,255,255,0.06)';
		roundRect(trackX, trackY, 4, trackH, 2);
		ctx.fill();
		ctx.fillStyle = 'rgba(160,190,230,0.5)';
		roundRect(trackX, thumbY, 4, thumbH, 2);
		ctx.fill();
		ctx.restore();
	}

	// Horizontal scrollbar for the whole column strip; only shown when it
	// overflows the viewport. Thumb at the left = leftmost columns revealed.
	function drawHScrollbar(): void {
		const s = lastStrip;
		if (!s || s.fits || s.maxPan <= s.minPan) return;
		const y = cssH - HSCROLL_BOTTOM;
		const range = s.maxPan - s.minPan;
		const t = range > 0 ? clamp((panSmooth - s.minPan) / range, 0, 1) : 0;
		const thumbX = s.trackX + (1 - t) * (s.trackW - s.thumbW);
		ctx.save();
		ctx.fillStyle = 'rgba(255,255,255,0.06)';
		roundRect(s.trackX, y, s.trackW, HSCROLL_H, HSCROLL_H / 2);
		ctx.fill();
		ctx.fillStyle = 'rgba(160,190,230,0.45)';
		roundRect(thumbX, y, s.thumbW, HSCROLL_H, HSCROLL_H / 2);
		ctx.fill();
		ctx.restore();
	}

	function draw(): void {
		const opts = getOptions();
		const geo = layout();
		const boxes = boxMap(geo);
		ctx.clearRect(0, 0, cssW, cssH);
		ctx.fillStyle = COLORS.bg;
		ctx.fillRect(0, 0, cssW, cssH);

		// edges behind nodes (semicircular hops on visible crossings)
		const hops = opts.hops ? computeHops(data.edges, boxes) : null;
		lastHopCount = 0;
		if (hops) for (const arr of hops.values()) lastHopCount += arr.length;
		for (const rec of data.edges) drawEdge(rec, boxes, opts, hops ? (hops.get(rec.from.uid) ?? null) : null);

		// fading stubs for hidden neighbours beyond the deepest visible column
		const outer = outerKeys();
		for (const g of geo) {
			if (g.col.key !== outer.left && g.col.key !== outer.right) continue;
			for (const box of g.boxes) {
				if (box.it.hasMore) drawStub(box, g.col.side === 'left' ? 'left' : 'right', 0.3);
			}
		}

		// nodes
		for (const g of geo) {
			for (const box of g.boxes) drawNode(box, g.col, opts, box.it.uid === hoverUid, box.it.uid === focusUid);
		}

		// column headers
		ctx.save();
		ctx.textBaseline = 'middle';
		for (const g of geo) {
			ctx.fillStyle = COLORS.header;
			ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
			const label = `${g.col.label} · ${g.col.items.length}`;
			ctx.fillText(label, g.x, CONTENT_TOP - 22);
			ctx.strokeStyle = COLORS.headerLine;
			ctx.lineWidth = 1;
			ctx.beginPath();
			ctx.moveTo(g.x, CONTENT_TOP - 10);
			ctx.lineTo(g.x + Math.min(g.w, 160), CONTENT_TOP - 10);
			ctx.stroke();
		}
		ctx.restore();

		for (const g of geo) if (g.col.key !== 'C') drawScrollbar(g);
		drawHScrollbar();
	}

	function tick(t: number): void {
		const dt = Math.min(48, t - (lastT || t) || 16);
		lastT = t;
		const k = 1 - Math.exp(-dt / 68);
		for (const g of data.columns) {
			if (g.key === 'C') continue;
			const s = getScroll(g.key);
			s.smooth += (s.inst - s.smooth) * k;
		}
		zoom += (zoomTarget - zoom) * k;
		panSmooth += (panInst - panSmooth) * k;
		draw();
		raf = requestAnimationFrame(tick);
	}

	function start(): void {
		if (raf) return;
		raf = requestAnimationFrame(tick);
	}

	function stop(): void {
		if (raf) cancelAnimationFrame(raf);
		raf = null;
	}

	function hitTest(cx: number, cy: number): HitResult | null {
		const geo = layout();
		for (const g of geo) {
			for (const b of g.boxes) {
				if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
					return { item: b.it, column: g.col, box: b };
				}
			}
		}
		return null;
	}

	function plusHit(cx: number, cy: number, hit: HitResult | null): boolean {
		if (!hit || hit.column.key === 'C') return false;
		const b = hit.box;
		const pr = 13;
		const px = b.x + b.w - pr - 3;
		const py = b.y + b.h - pr - 3;
		return cx >= px - 3 && cx <= px + pr + 3 && cy >= py - 3 && cy <= py + pr + 3;
	}

	function boxOf(uid: string): { box: Box; col: LocalColumn } | null {
		const geo = lastGeo.length ? lastGeo : layout();
		for (const g of geo) {
			for (const b of g.boxes) if (b.it.uid === uid) return { box: b, col: g.col };
		}
		return null;
	}

	function ensureVisible(box: Box, col: LocalColumn): void {
		if (col.key === 'C') return;
		const s = getScroll(col.key);
		const top = CONTENT_TOP;
		const bottom = CONTENT_TOP + Math.max(60, cssH - CONTENT_TOP - CONTENT_BOTTOM);
		const cy = box.y + box.h / 2;
		if (cy - box.h / 2 < top) s.inst = clamp(s.inst - (top - (cy - box.h / 2)) - 8, 0, s.max);
		else if (cy + box.h / 2 > bottom) s.inst = clamp(s.inst + (cy + box.h / 2 - bottom) + 8, 0, s.max);
		// keep the focused column visible horizontally too
		const strip = lastStrip;
		if (strip && !strip.fits) {
			const m = STRIP_MARGIN;
			if (box.x < m) panInst = clamp(panInst + (m - box.x), strip.minPan, strip.maxPan);
			else if (box.x + box.w > cssW - m)
				panInst = clamp(panInst - (box.x + box.w - (cssW - m)), strip.minPan, strip.maxPan);
		}
	}

	function setFocus(uid: string | null): void {
		focusUid = uid;
		if (!uid) return;
		const f = boxOf(uid);
		if (f) ensureVisible(f.box, f.col);
	}

	function getFocused(): LocalItem | null {
		if (!focusUid) return null;
		const f = boxOf(focusUid);
		return f ? f.box.it : null;
	}

	function focusInfo(): FocusInfo | null {
		if (!focusUid) return null;
		const f = boxOf(focusUid);
		if (!f) return null;
		const it = f.box.it;
		return {
			uid: it.uid,
			id: it.id,
			name: it.node.name,
			file: it.node.file,
			line: it.node.line,
			column: f.col.key
		};
	}

	// Arrow-key navigation: up/down within a column, left/right to the nearest
	// item in the adjacent column (by vertical centre).
	function moveFocus(dir: 'up' | 'down' | 'left' | 'right'): LocalItem | null {
		const geo = layout();
		if (!geo.length) return null;
		let curBox: Box | null = null;
		let curGeo: Geo | null = null;
		if (focusUid) {
			for (const g of geo) {
				for (const b of g.boxes) {
					if (b.it.uid === focusUid) {
						curBox = b;
						curGeo = g;
						break;
					}
				}
				if (curBox) break;
			}
		}
		if (!curBox || !curGeo) {
			const cg = geo.find((g) => g.col.key === 'C') ?? geo[Math.floor(geo.length / 2)];
			const b = cg.boxes[Math.floor(cg.boxes.length / 2)] ?? cg.boxes[0];
			if (!b) return null;
			setFocus(b.it.uid);
			return b.it;
		}
		if (dir === 'up' || dir === 'down') {
			const list = curGeo.col.items;
			const i = list.findIndex((it) => it.uid === focusUid);
			const target = list[clamp(i + (dir === 'up' ? -1 : 1), 0, list.length - 1)];
			if (!target) return curBox.it;
			setFocus(target.uid);
			return target;
		}
		const ordered = geo.slice().sort((a, b) => a.x - b.x);
		const ci = ordered.findIndex((g) => g.col.key === curGeo.col.key);
		const ti = clamp(ci + (dir === 'left' ? -1 : 1), 0, ordered.length - 1);
		if (ti === ci) return curBox.it;
		const targetGeo = ordered[ti];
		if (!targetGeo.boxes.length) return curBox.it;
		const cy = curBox.y + curBox.h / 2;
		let best = targetGeo.boxes[0];
		let bestD = Infinity;
		for (const b of targetGeo.boxes) {
			const d = Math.abs(b.y + b.h / 2 - cy);
			if (d < bestD) {
				bestD = d;
				best = b;
			}
		}
		setFocus(best.it.uid);
		return best.it;
	}

	function setData(next: ColumnData): void {
		data = next;
		// drop scroll state for columns that changed identity
		const keys = new Set(next.columns.map((c) => c.key));
		for (const k of [...scroll.keys()]) if (!keys.has(k)) scroll.delete(k);
		if (focusUid) {
			let found = false;
			for (const c of next.columns) for (const it of c.items) if (it.uid === focusUid) found = true;
			if (!found) focusUid = null;
		}
	}

	function resetScroll(): void {
		for (const s of scroll.values()) {
			s.inst = 0;
			s.smooth = 0;
		}
		panInst = 0;
		panSmooth = 0;
	}

	function onWheel(e: WheelEvent): void {
		const rect = canvas.getBoundingClientRect();
		const cx = e.clientX - rect.left;
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			zoomTarget = clamp(zoomTarget * Math.exp(-e.deltaY * 0.0016), 0.32, 2.4);
			return;
		}
		// horizontal panning of the whole strip: shift+wheel or trackpad deltaX
		const strip = lastStrip;
		const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
		if (strip && !strip.fits && horizontal) {
			e.preventDefault();
			const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
			panInst = clamp(panInst + delta, strip.minPan, strip.maxPan);
			return;
		}
		const geo = layout();
		const g = geo.find((gg) => cx >= gg.x - 12 && cx <= gg.x + gg.w + 12);
		if (!g || g.col.key === 'C') return;
		e.preventDefault();
		const s = getScroll(g.col.key);
		s.inst += e.deltaY;
	}

	function onMove(e: MouseEvent): void {
		const rect = canvas.getBoundingClientRect();
		const cx = e.clientX - rect.left;
		const cy = e.clientY - rect.top;
		if (drag) {
			const dx = e.clientX - drag.startX;
			if (Math.abs(dx) > 2) drag.moved = true;
			const strip = lastStrip;
			if (strip && !strip.fits) {
				if (drag.mode === 'thumb') {
					const thumbRange = Math.max(1, strip.trackW - strip.thumbW);
					const panRange = strip.maxPan - strip.minPan;
					panInst = clamp(drag.startPan - dx * (panRange / thumbRange), strip.minPan, strip.maxPan);
				} else {
					panInst = clamp(drag.startPan + dx, strip.minPan, strip.maxPan);
				}
			}
			return;
		}
		const hit = hitTest(cx, cy);
		const uid = hit ? hit.item.uid : null;
		const plus = hit ? plusHit(cx, cy, hit) : false;
		if (uid !== hoverUid || plus !== hoverPlus) {
			hoverUid = uid;
			hoverPlus = plus;
			canvas.style.cursor = hoverPlus ? 'copy' : hit ? 'pointer' : 'default';
			if (handlers.onHover) handlers.onHover(hit ? hit.item : null, { plus });
		}
	}

	function onDown(e: MouseEvent): void {
		if (e.button !== 0) return;
		const rect = canvas.getBoundingClientRect();
		const cx = e.clientX - rect.left;
		const cy = e.clientY - rect.top;
		const strip = lastStrip;
		if (strip && !strip.fits && strip.maxPan > strip.minPan) {
			const y = cssH - HSCROLL_BOTTOM;
			if (cy >= y - 6 && cy <= y + HSCROLL_H + 6 && cx >= strip.trackX && cx <= strip.trackX + strip.trackW) {
				const t = clamp((cx - strip.trackX) / strip.trackW, 0, 1);
				panInst = clamp(strip.maxPan - t * (strip.maxPan - strip.minPan), strip.minPan, strip.maxPan);
				drag = { mode: 'thumb', startX: e.clientX, startPan: panInst, moved: false };
				e.preventDefault();
				return;
			}
		}
		// dragging the empty background pans the strip horizontally
		if (hitTest(cx, cy)) return;
		if (!strip || strip.fits || strip.maxPan <= strip.minPan) return;
		drag = { mode: 'pan', startX: e.clientX, startPan: panInst, moved: false };
		e.preventDefault();
	}

	function onUp(): void {
		if (!drag) return;
		if (drag.moved) {
			suppressClick = true;
			// clear after the click that follows mouseup, so a drag ending
			// outside the canvas can never swallow a later real click
			setTimeout(() => (suppressClick = false), 0);
		}
		drag = null;
	}

	function onClick(e: MouseEvent): void {
		if (suppressClick) {
			suppressClick = false;
			return;
		}
		const rect = canvas.getBoundingClientRect();
		const cx = e.clientX - rect.left;
		const cy = e.clientY - rect.top;
		const hit = hitTest(cx, cy);
		if (!hit) {
			if (handlers.onBackground) handlers.onBackground();
			return;
		}
		const plus = plusHit(cx, cy, hit);
		if (handlers.onClick) handlers.onClick(hit.item, e, { plus });
	}

	canvas.addEventListener('wheel', onWheel, { passive: false });
	canvas.addEventListener('mousemove', onMove);
	canvas.addEventListener('mousedown', onDown);
	canvas.addEventListener('click', onClick);
	window.addEventListener('mouseup', onUp);

	return {
		setData,
		setHandlers(h: RendererHandlers): void {
			handlers = h;
		},
		start,
		stop,
		resize,
		resetScroll,
		setFocus,
		getFocused,
		focusInfo,
		moveFocus,
		clearFocus(): void {
			focusUid = null;
		},
		hitTest,
		debugHopCount: () => lastHopCount,
		debugStrip: () =>
			lastStrip ? { ...lastStrip, pan: panInst, panSmooth } : null
	};
}
