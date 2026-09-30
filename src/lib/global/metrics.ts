/**
 * Metrics for the global density view — fixed spec from
 * `tmp/scip-graph-viewer/README.md` / `todo-scip-graph.md` §4.
 *
 *   nodeOverlapRatio = intersecting node-rect pairs / C(n,2)   (hard: 0)
 *   fillNet          = area(union of node rects) / area(bbox)
 *
 * Rect is stored as { x, y, hw, hh }. Faithful TypeScript port of
 * `view-a/lib/metrics.js`. Both the overlap ratio and fill use the *drawn*
 * rectangles (the weight-scaled `hw`/`hh` carried on every aggregate node).
 */

/** Any object with a centre position and half-extents (the drawn rect). */
export type RectLike = { x: number; y: number; hw: number; hh: number };

export type Rect = { lx: number; rx: number; ty: number; by: number };

export type BBox = { lx: number; rx: number; ty: number; by: number; w: number; h: number };

export type GraphMetrics = {
  nodes: number;
  nodeOverlapPairs: number;
  nodeOverlapRatio: number;
  fillNet: number;
  bbox: BBox;
};

export function rectOf(node: RectLike): Rect {
  return {
    lx: node.x - node.hw,
    rx: node.x + node.hw,
    ty: node.y - node.hh,
    by: node.y + node.hh,
  };
}

/** Number of intersecting drawn-rect pairs. */
export function nodeOverlapPairs(nodes: RectLike[]): number {
  let pairs = 0;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const dx = Math.abs(a.x - b.x);
      const dy = Math.abs(a.y - b.y);
      if (dx < a.hw + b.hw && dy < a.hh + b.hh) pairs++;
    }
  }
  return pairs;
}

/** Intersecting drawn-rect pairs / C(n, 2). */
export function nodeOverlapRatio(nodes: RectLike[]): number {
  const n = nodes.length;
  if (n < 2) return 0;
  return nodeOverlapPairs(nodes) / ((n * (n - 1)) / 2);
}

/** Bounding box of the drawn rects (not the centres). */
export function bbox(nodes: RectLike[]): BBox {
  if (!nodes.length) return { lx: 0, rx: 0, ty: 0, by: 0, w: 0, h: 0 };
  let lx = Infinity;
  let rx = -Infinity;
  let ty = Infinity;
  let by = -Infinity;
  for (const node of nodes) {
    lx = Math.min(lx, node.x - node.hw);
    rx = Math.max(rx, node.x + node.hw);
    ty = Math.min(ty, node.y - node.hh);
    by = Math.max(by, node.y + node.hh);
  }
  return { lx, rx, ty, by, w: rx - lx, h: by - ty };
}

/** Exact union area of axis-aligned rects via x-sweep + merged y-intervals. */
export function unionArea(nodes: RectLike[]): number {
  if (!nodes.length) return 0;
  const rects = nodes.map(rectOf);
  const xs = [...new Set(rects.flatMap((r) => [r.lx, r.rx]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    if (x1 <= x0) continue;
    const ys: [number, number][] = [];
    for (const r of rects) {
      if (r.lx < x1 && r.rx > x0) ys.push([r.ty, r.by]);
    }
    if (!ys.length) continue;
    ys.sort((a, b) => a[0] - b[0]);
    let cov = 0;
    let cy0 = ys[0][0];
    let cy1 = ys[0][1];
    for (let k = 1; k < ys.length; k++) {
      const [y0, y1] = ys[k];
      if (y0 > cy1) {
        cov += cy1 - cy0;
        cy0 = y0;
        cy1 = y1;
      } else if (y1 > cy1) {
        cy1 = y1;
      }
    }
    cov += cy1 - cy0;
    area += (x1 - x0) * cov;
  }
  return area;
}

/** Union area of the drawn rects / bbox area. */
export function fillNet(nodes: RectLike[]): number {
  const box = bbox(nodes);
  const area = box.w * box.h;
  if (area <= 0) return 0;
  return unionArea(nodes) / area;
}

/** Independent main-thread re-derivation of the worker's reported metrics. */
export function computeMetrics(nodes: RectLike[]): GraphMetrics {
  return {
    nodes: nodes.length,
    nodeOverlapPairs: nodeOverlapPairs(nodes),
    nodeOverlapRatio: nodeOverlapRatio(nodes),
    fillNet: fillNet(nodes),
    bbox: bbox(nodes),
  };
}
