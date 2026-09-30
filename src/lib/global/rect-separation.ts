/**
 * Deterministic drawn-rectangle separation shared by the live d3-force layout
 * worker (`layout.worker.ts`) and the offline ELK precompute
 * (`scripts/precompute-elk.ts`).
 *
 * Both paths must produce a layout with `nodeOverlapRatio === 0`, so the exact
 * Gauss-Seidel pass below is the single source of truth: a fixed pair order
 * (no randomness, no spatial hashing) makes it byte-for-byte reproducible.
 *
 * The `x`/`y` fields are the *centre* of the drawn rectangle; `hw`/`hh` are its
 * half-extents in world units.
 */

/** Extra world-unit cushion added to the circumscribed radius used by collide. */
export const RECT_MARGIN = 0.6;

/** Any positioned rectangle with centre + half-extents. */
export type RectNode = { x: number; y: number; hw: number; hh: number };

/** Exact half-diagonal radius per node (circumscribed circle). */
export function radiusOf(node: { hw: number; hh: number }): number {
  return Math.hypot(node.hw, node.hh) + RECT_MARGIN;
}

/** Number of intersecting drawn-rect pairs (O(n^2), strict overlap test). */
export function countOverlaps(nodes: readonly RectNode[]): number {
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

/**
 * Deterministic Gauss-Seidel rect separation on the ACTUAL drawn rectangles,
 * along the minimum-penetration axis. This targets the `nodeOverlapRatio`
 * metric directly (no circumscribed-circle conservatism). Fixed pair order
 * makes it reproducible. Returns the number of passes used.
 */
export function separateRects<T extends RectNode>(nodes: T[], maxPasses = 250): number {
  const n = nodes.length;
  let pass = 0;
  for (; pass < maxPasses; pass++) {
    let moved = 0;
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < n; j++) {
        const b = nodes[j];
        const ox = a.hw + b.hw - Math.abs(a.x - b.x);
        if (ox <= 0) continue;
        const oy = a.hh + b.hh - Math.abs(a.y - b.y);
        if (oy <= 0) continue;
        moved++;
        if (ox <= oy) {
          const sign = a.x <= b.x ? -1 : 1;
          const push = ox / 2 + 1e-3;
          a.x += sign * push;
          b.x -= sign * push;
        } else {
          const sign = a.y <= b.y ? -1 : 1;
          const push = oy / 2 + 1e-3;
          a.y += sign * push;
          b.y -= sign * push;
        }
      }
    }
    if (moved === 0) break;
  }
  return pass;
}

/** Bounding box of the drawn rects (not the centres). */
export function bboxOf(nodes: readonly RectNode[]): {
  lx: number;
  rx: number;
  ty: number;
  by: number;
  w: number;
  h: number;
} {
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

/** Exact union area of drawn rects (x-sweep + merged y-intervals). */
export function unionArea(nodes: readonly RectNode[]): number {
  if (!nodes.length) return 0;
  const rects = nodes.map((n) => ({
    lx: n.x - n.hw,
    rx: n.x + n.hw,
    ty: n.y - n.hh,
    by: n.y + n.hh,
  }));
  const xs = [...new Set(rects.flatMap((r) => [r.lx, r.rx]))].sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i];
    const x1 = xs[i + 1];
    if (x1 <= x0) continue;
    const ys: [number, number][] = [];
    for (const r of rects) if (r.lx < x1 && r.rx > x0) ys.push([r.ty, r.by]);
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
