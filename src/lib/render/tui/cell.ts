/**
 * 简单字符格缓冲：TUI 的「世界」。
 *
 * 立即模式绘制（box / polyline / text），与终端库无关 —— 自研 TUI 直接输出，
 * opentui 的自定义 Renderable 则把这里的 draw 结果 blit 进它的 buffer。
 */

import type { CellRect } from '../../core/model';

export interface Cell {
  ch: string;
  fg?: string;
}

export type Dir = 'up' | 'down' | 'left' | 'right';

const hexToAnsi = (hex: string): string => {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
};

const CORNERS: Record<string, string> = {
  // prevDir|nextDir → 连接两个开口的方框符（缺一个就会退化成 ┼）
  'down|right': '╭',
  'down|left': '╮',
  'up|right': '╰',
  'up|left': '╯',
  'right|down': '╮',
  'left|down': '╭',
  'right|up': '╯',
  'left|up': '╰',
  'up|down': '│',
  'down|up': '│',
  'left|right': '─',
  'right|left': '─',
  'up|up': '│',
  'down|down': '│',
  'left|left': '─',
  'right|right': '─',
};

const ARROWS: Record<Dir, string> = { right: '▸', left: '◂', down: '▾', up: '▴' };

/** 字符格缓冲。 */
export class CellBuffer {
  private data: Cell[][];

  constructor(
    public width: number,
    public height: number,
  ) {
    this.data = Array.from({ length: height }, () =>
      Array.from({ length: width }, (): Cell => ({ ch: ' ' })),
    );
  }

  set(row: number, col: number, ch: string, fg?: string): void {
    if (row < 0 || row >= this.height || col < 0 || col >= this.width) return;
    this.data[row]![col] = fg ? { ch, fg } : { ch };
  }

  text(row: number, col: number, s: string, fg?: string): void {
    let c = col;
    for (const ch of s) this.set(row, c++, ch, fg);
  }

  box(r: CellRect, opts: { fg?: string; title?: string; titleColor?: string } = {}): void {
    const { col, row, width, height } = r;
    if (width < 2 || height < 2) return;
    const right = col + width - 1;
    const bottom = row + height - 1;
    this.set(row, col, '╭', opts.fg);
    this.set(row, right, '╮', opts.fg);
    this.set(bottom, col, '╰', opts.fg);
    this.set(bottom, right, '╯', opts.fg);
    for (let c = col + 1; c < right; c++) {
      this.set(row, c, '─', opts.fg);
      this.set(bottom, c, '─', opts.fg);
    }
    for (let rr = row + 1; rr < bottom; rr++) {
      this.set(rr, col, '│', opts.fg);
      this.set(rr, right, '│', opts.fg);
    }
    if (opts.title) this.text(row, col + 2, ` ${opts.title} `, opts.titleColor ?? opts.fg);
  }

  hline(row: number, col: number, len: number, ch = '─', fg?: string): void {
    for (let i = 0; i < len; i++) this.set(row, col + i, ch, fg);
  }

  vline(col: number, row: number, len: number, ch = '│', fg?: string): void {
    for (let i = 0; i < len; i++) this.set(row + i, col, ch, fg);
  }

  /** 折线：轴对齐段落 + 拐角 + 末端箭头。 */
  polyline(pts: { col: number; row: number }[], fg?: string): void {
    if (pts.length < 2) return;
    const dirOf = (a: { col: number; row: number }, b: { col: number; row: number }): Dir =>
      a.row === b.row ? (b.col >= a.col ? 'right' : 'left') : b.row > a.row ? 'down' : 'up';
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      if (a.row === b.row) {
        const [s, e] = a.col <= b.col ? [a.col, b.col] : [b.col, a.col];
        for (let c = s + 1; c < e; c++) this.set(a.row, c, '─', fg);
      } else {
        const [s, e] = a.row <= b.row ? [a.row, b.row] : [b.row, a.row];
        for (let rr = s + 1; rr < e; rr++) this.set(rr, a.col, '│', fg);
      }
    }
    for (let i = 1; i < pts.length - 1; i++) {
      const ch = CORNERS[`${dirOf(pts[i - 1]!, pts[i]!)}|${dirOf(pts[i]!, pts[i + 1]!)}`] ?? '┼';
      this.set(pts[i]!.row, pts[i]!.col, ch, fg);
    }
    const end = pts[pts.length - 1]!;
    const endDir = dirOf(pts[pts.length - 2]!, end);
    this.set(end.row, end.col, ARROWS[endDir], fg);
  }

  /** 读单元格（供外部 blit / 测试）。 */
  cell(row: number, col: number): Cell {
    return this.data[row]?.[col] ?? { ch: ' ' };
  }

  /** 与上一帧对比，只输出变化的单元格（细粒度差分渲染）。 */
  diff(prev: CellBuffer): string {
    if (prev.width !== this.width || prev.height !== this.height) {
      return '\x1b[2J' + this.toString({ color: true });
    }
    let out = '';
    let row = -1;
    let col = -1;
    let fg: string | undefined;
    for (let r = 0; r < this.height; r++) {
      for (let c = 0; c < this.width; c++) {
        const a = prev.data[r]![c]!;
        const b = this.data[r]![c]!;
        if (a.ch === b.ch && a.fg === b.fg) continue;
        if (r !== row || c !== col) {
          out += `\x1b[${r + 1};${c + 1}H`;
          row = r;
          col = c;
          fg = undefined;
        }
        if (b.fg !== fg) {
          out += b.fg ? hexToAnsi(b.fg) : '\x1b[39m';
          fg = b.fg;
        }
        out += b.ch;
        col++;
      }
    }
    return out ? out + '\x1b[0m' : '';
  }

  toString(opts: { color?: boolean } = {}): string {
    const color = opts.color ?? true;
    const lines: string[] = [];
    for (let r = 0; r < this.height; r++) {
      let line = '';
      let cur: string | undefined;
      for (let c = 0; c < this.width; c++) {
        const cell = this.data[r]![c]!;
        if (color && cell.fg !== cur) {
          if (cur !== undefined) line += '\x1b[0m';
          if (cell.fg) line += hexToAnsi(cell.fg);
          cur = cell.fg;
        }
        line += cell.ch;
      }
      if (color && cur !== undefined) line += '\x1b[0m';
      lines.push(line.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }
}
