/**
 * Canvas 2D renderer for the butterfly view (faithful TS port of
 * `view-b/render.js`): columns of nodes, per-layer independent smooth scroll,
 * bezier links with fading arrowheads, clickable nodes. The centre column never
 * scrolls and stays horizontally fixed.
 */
import type { LocalColumn, LocalItem, LocalLink, LocalOptions } from '$lib/local/model';

type ColumnData = { columns: LocalColumn[]; edges: LocalLink[] };

export type RendererHandlers = {
	onClick?: (item: LocalItem, ev: MouseEvent, info: { plus: boolean }) => void;
	onHover?: (item: LocalItem | null, info: { plus: boolean }) => void;
	onBackground?: () => void;
};

export type HitResult = { item: LocalItem; column: LocalColumn; box: Box };

type Box = { it: LocalItem; x: number; y: number; w: number; h: number };
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

const DEPTH_SCALE: Record<number, number> = { 0: 1, 1: 0.82, 2: 0.66 };
const BASE_W = 214;
const BASE_H = 58;
const ROW_GAP = 16;
const GAP_X = 104;
const CONTENT_TOP = 58;
const CONTENT_BOTTOM = 34;

const COLORS = {
	bg: '#0e1116',
	header: '#8ea0b8',
	headerLine: '#26303d',
	nodeLeft: '#1b2634',
	nodeRight: '#1b2a24',
	nodeCenter: '#2b2138',
	nodeStroke: '#3c4c62',
	centerStroke: '#b98cff',
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
	let cssW = 1;
	let cssH = 1;
	let raf: number | null = null;
	let lastT = 0;
	let lastGeo: Geo[] = [];

	function getScroll(key: string): { inst: number; smooth: number; max: number } {
		let s = scroll.get(key);
		if (!s) scroll.set(key, (s = { inst: 0, smooth: 0, max: 0 }));
		return s;
	}

	function dimsFor(depth: number): { w: number; h: number; rowGap: number; scale: number } {
		const s = zoom * (DEPTH_SCALE[depth] ?? 1);
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

		let x = centerX + cd.w + gap;
		const right: Geo[] = [];
		for (const key of ['R1', 'R2']) {
			const col = byKey.get(key);
			if (!col) continue;
			const d = dimsFor(col.depth);
			right.push({ col, x, ...d, boxes: [], step: 0, contentH: 0, availH: 0 });
			x += d.w + gap;
		}
		let lx = centerX - gap;
		const left: Geo[] = [];
		for (const key of ['L1', 'L2']) {
			const col = byKey.get(key);
			if (!col) continue;
			const d = dimsFor(col.depth);
			left.push({ col, x: lx - d.w, ...d, boxes: [], step: 0, contentH: 0, availH: 0 });
			lx = lx - d.w - gap;
		}
		geo.push(...left.reverse(), { col: center, x: centerX, ...cd, boxes: [], step: 0, contentH: 0, availH: 0 }, ...right);

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

	function drawEdge(rec: LocalLink, boxes: Map<string, Box>, opts: LocalOptions): void {
		const a = boxes.get(rec.from.uid);
		const b = boxes.get(rec.to.uid);
		if (!a || !b) return;
		const ay = a.y + a.h / 2;
		const by = b.y + b.h / 2;
		const rgb = edgeRGB(rec.data.dispatch);
		const depth = Math.max(rec.from.depth, rec.to.depth);
		let alpha = depth >= 2 ? 0.26 : depth === 1 ? 0.5 : 0.72;
		if (!rec.valid) alpha = 0.1;
		const p0 = { x: a.x + a.w, y: ay };
		const p3 = rec.internal ? { x: b.x + b.w, y: by } : { x: b.x, y: by };
		const dx = rec.internal ? 52 * zoom : Math.max(22, Math.abs(p3.x - p0.x) * 0.42);
		const c1 = { x: p0.x + dx, y: p0.y };
		const c2 = { x: rec.internal ? p3.x + dx : p3.x - dx, y: p3.y };

		ctx.save();
		ctx.strokeStyle = rgba(rgb, alpha);
		ctx.lineWidth = rec.bridged ? 1.1 : 1.6;
		if (!rec.valid) ctx.setLineDash([4, 5]);
		if (rec.bridged) ctx.setLineDash([7, 4]);

		const calls =
			opts.perCallArrows && rec.data.sites && rec.data.sites.length > 1 ? rec.data.sites.length : 1;
		for (let k = 0; k < calls; k++) {
			const off = calls > 1 ? (k - (calls - 1) / 2) * 5 : 0;
			ctx.beginPath();
			ctx.moveTo(p0.x, p0.y + off);
			ctx.bezierCurveTo(c1.x, c1.y + off, c2.x, c2.y + off, p3.x, p3.y + off);
			ctx.stroke();
		}
		ctx.setLineDash([]);
		arrowHead(p3.x, p3.y, p3.x - c2.x, p3.y - c2.y, 8, alpha + 0.08);

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

	function drawNode(box: Box, col: LocalColumn, opts: LocalOptions, isHover: boolean): void {
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

	function draw(): void {
		const opts = getOptions();
		const geo = layout();
		const boxes = boxMap(geo);
		ctx.clearRect(0, 0, cssW, cssH);
		ctx.fillStyle = COLORS.bg;
		ctx.fillRect(0, 0, cssW, cssH);

		// edges behind nodes
		for (const rec of data.edges) drawEdge(rec, boxes, opts);

		// fading stubs for hidden grandparents / grandchildren
		for (const g of geo) {
			if (g.col.key !== 'L2' && g.col.key !== 'R2') continue;
			for (const box of g.boxes) {
				if (box.it.hasMore) drawStub(box, g.col.side === 'left' ? 'left' : 'right', 0.3);
			}
		}

		// nodes
		for (const g of geo) {
			for (const box of g.boxes) drawNode(box, g.col, opts, box.it.uid === hoverUid);
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

	function setData(next: ColumnData): void {
		data = next;
		// drop scroll state for columns that changed identity
		const keys = new Set(next.columns.map((c) => c.key));
		for (const k of [...scroll.keys()]) if (!keys.has(k)) scroll.delete(k);
	}

	function resetScroll(): void {
		for (const s of scroll.values()) {
			s.inst = 0;
			s.smooth = 0;
		}
	}

	function onWheel(e: WheelEvent): void {
		const rect = canvas.getBoundingClientRect();
		const cx = e.clientX - rect.left;
		if (e.ctrlKey || e.metaKey) {
			e.preventDefault();
			zoomTarget = clamp(zoomTarget * Math.exp(-e.deltaY * 0.0016), 0.32, 2.4);
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

	function onClick(e: MouseEvent): void {
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
	canvas.addEventListener('click', onClick);

	return {
		setData,
		setHandlers(h: RendererHandlers): void {
			handlers = h;
		},
		start,
		stop,
		resize,
		resetScroll,
		hitTest,
		debugBoxes: () =>
			layout().flatMap((g) =>
				g.boxes.map((b) => ({ uid: b.it.uid, id: b.it.id, column: g.col.key, x: b.x, y: b.y, w: b.w, h: b.h }))
			),
		geometry: () => lastGeo.map((g) => ({ key: g.col.key, x: g.x, w: g.w, n: g.col.items.length })),
		zoomTo(z: number): void {
			zoomTarget = clamp(z, 0.32, 2.4);
		},
		getZoom: () => zoom
	};
}
