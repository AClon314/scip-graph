/**
 * Metrics for the global density view — fixed spec from
 * `tmp/scip-graph-viewer/README.md` / `todo-scip-graph.md` §4.
 *
 *   nodeOverlapRatio = intersecting node-rect pairs / C(n,2)   (hard: 0)
 *   fillNet          = area(union of node rects) / area(bbox)
 *
 * Rect is stored as { x, y, hw, hh }.
 *
 * The low-level rect geometry (`countOverlaps` / `bboxOf` / `unionArea`) lives
 * in `rect-separation.ts`, which is shared with the layout worker and the
 * offline precompute scripts. This module is the main-thread metric facade on
 * top of it (and the independent re-derivation the page uses to verify the
 * worker's reported numbers).
 */

import { bboxOf, countOverlaps, unionArea, type RectNode } from './rect-separation';

/** Re-exported for callers that imported the union-area helper from here. */
export { unionArea };

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
  return countOverlaps(nodes as RectNode[]);
}

/** Intersecting drawn-rect pairs / C(n, 2). */
export function nodeOverlapRatio(nodes: RectLike[]): number {
  const n = nodes.length;
  if (n < 2) return 0;
  return nodeOverlapPairs(nodes) / ((n * (n - 1)) / 2);
}

/** Bounding box of the drawn rects (not the centres). */
export function bbox(nodes: RectLike[]): BBox {
  return bboxOf(nodes as RectNode[]);
}

/** Union area of the drawn rects / bbox area. */
export function fillNet(nodes: RectLike[]): number {
  const box = bbox(nodes);
  const area = box.w * box.h;
  if (area <= 0) return 0;
  return unionArea(nodes as RectNode[]) / area;
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
