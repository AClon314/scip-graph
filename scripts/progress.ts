#!/usr/bin/env bun
/**
 * Tiny, dependency-free, multi-metric progress renderer shared by the offline
 * precompute scripts (`precompute-force.ts`, `precompute-elk.ts`).
 *
 * On a TTY it redraws a small block of live lines in place (ANSI cursor-up +
 * clear). When the stream is not a TTY (CI, redirected logs, some `script`
 * wrappers) it degrades to periodic single-line snapshots so the log stays
 * readable.
 *
 * API:
 *   const p = new Progress({ label: 'precompute:force' });
 *   p.section('d3-force', 'tick');   // phase + optional progress-bar label
 *   p.set('nodes', 1780);            // arbitrary metric (key/value)
 *   p.tick(120, 400);                // absolute bar; `p.tick(10)` increments
 *   p.done();                        // finalize (keeps the last frame on screen)
 *
 * No `cli-progress` (or any other dependency).
 */

export interface ProgressStream {
  isTTY?: boolean;
  write(chunk: string): boolean | void;
  columns?: number;
}

export interface ProgressOptions {
  /** Prefix shown on every line, e.g. `precompute:elk`. */
  label?: string;
  /** Output stream (defaults to `process.stdout`). */
  stream?: ProgressStream;
  /** Force TTY mode on/off (defaults to `stream.isTTY`). */
  tty?: boolean;
  /** Disable ANSI colours even on a TTY (also honours `NO_COLOR`). */
  color?: boolean;
  /** Minimum ms between TTY redraws. */
  minIntervalMs?: number;
  /** Minimum ms between non-TTY plain snapshots. */
  plainIntervalMs?: number;
  /** Heartbeat period for time-only updates (elapsed while awaiting async work). */
  heartbeatMs?: number;
}

type MetricValue = string | number;

interface Bar {
  label: string;
  current: number;
  total: number;
}

const ANSI = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
} as const;

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/** Compact human duration: `840ms`, `3.2s`, `2m07s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}m${String(rest).padStart(2, '0')}s`;
}

/** `1780`, `0.2412`, `6466.3` — integers verbatim, floats rounded to 4 dp. */
function formatValue(value: MetricValue): string {
  if (typeof value !== 'number') return value;
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1e4) / 1e4);
}

function renderBar(bar: Bar, width: number): string {
  // An unknown total (e.g. "cleanup pass k") renders as a live counter.
  if (!(bar.total > 0)) return `${bar.label} ${bar.current}`;
  const ratio = Math.min(1, Math.max(0, bar.current / bar.total));
  const filled = Math.round(ratio * width);
  const track = `${'#'.repeat(filled)}${'-'.repeat(Math.max(0, width - filled))}`;
  const pct = String(Math.round(ratio * 100)).padStart(3);
  return `${bar.label} [${track}] ${pct}%  ${bar.current}/${bar.total}`;
}

/** Multi-metric, in-place progress reporter (see module doc). */
export class Progress {
  private readonly stream: ProgressStream;
  private readonly tty: boolean;
  private readonly color: boolean;
  private readonly label: string;
  private readonly minIntervalMs: number;
  private readonly plainIntervalMs: number;
  private readonly heartbeatMs: number;

  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastRenderAt = 0;
  private lastPlainAt = 0;
  private frameLines = 0;
  private phase = '';
  private sectionStartedAt = 0;
  private bar: Bar | null = null;
  private readonly metrics = new Map<string, MetricValue>();

  constructor(options: ProgressOptions = {}) {
    this.stream = options.stream ?? (process.stdout as unknown as ProgressStream);
    this.tty = options.tty ?? Boolean(this.stream.isTTY);
    const noColor = typeof process !== 'undefined' && Boolean(process.env?.NO_COLOR);
    this.color = options.color ?? (this.tty && !noColor);
    this.label = options.label ?? 'progress';
    this.minIntervalMs = options.minIntervalMs ?? 80;
    this.plainIntervalMs = options.plainIntervalMs ?? 2000;
    this.heartbeatMs = options.heartbeatMs ?? 250;
  }

  /** Start a new phase. `barLabel` enables a progress bar for this phase. */
  section(name: string, barLabel?: string): void {
    this.phase = name;
    this.sectionStartedAt = now();
    this.bar = barLabel ? { label: barLabel, current: 0, total: 0 } : null;
    this.startHeartbeat();
    this.render(true);
  }

  /** Set (or replace) a named metric. */
  set(key: string, value: MetricValue): void {
    this.metrics.set(key, value);
    this.render();
  }

  /**
   * Advance the current phase's bar.
   *   `tick(10)`       -> increment by 10
   *   `tick(120, 400)` -> set absolute 120 / 400
   */
  tick(amountOrCurrent = 1, total?: number): void {
    if (!this.bar) this.bar = { label: this.phase || 'progress', current: 0, total: 0 };
    if (total !== undefined) {
      this.bar.current = amountOrCurrent;
      this.bar.total = total;
    } else {
      this.bar.current += amountOrCurrent;
    }
    this.render();
  }

  /** Finalize the live block. The last frame stays on screen. */
  done(message?: string): void {
    this.render(true);
    this.stopHeartbeat();
    this.frameLines = 0;
    if (message && message.length > 0) this.stream.write(`${message}\n`);
  }

  // -- rendering ------------------------------------------------------------

  private elapsed(): number {
    return this.sectionStartedAt > 0 ? now() - this.sectionStartedAt : 0;
  }

  private headerLine(): string {
    const parts = [`${this.labelText()} ${this.phase || 'working'}`];
    parts.push(`elapsed ${formatDuration(this.elapsed())}`);
    if (this.bar && this.bar.total > 0) {
      parts.push(`iter ${this.bar.current}/${this.bar.total}`);
      const eta = this.eta();
      if (eta !== null) parts.push(`eta ${formatDuration(eta)}`);
    } else if (this.bar && this.bar.current > 0) {
      parts.push(`${this.bar.label} ${this.bar.current}`);
    }
    return parts.join('  ');
  }

  private eta(): number | null {
    if (!this.bar || this.bar.total <= 0 || this.bar.current <= 0) return null;
    return (this.elapsed() * (this.bar.total - this.bar.current)) / this.bar.current;
  }

  private labelText(): string {
    return this.color ? `${ANSI.cyan}[${this.label}]${ANSI.reset}` : `[${this.label}]`;
  }

  private frame(): string[] {
    const lines = [this.headerLine()];
    if (this.bar) lines.push(`  ${renderBar(this.bar, 24)}`);
    if (this.metrics.size > 0) {
      const metrics = [...this.metrics].map(([key, value]) => `${key} ${formatValue(value)}`).join(' · ');
      lines.push(`  ${this.color ? ANSI.dim : ''}${metrics}${this.color ? ANSI.reset : ''}`);
    }
    return lines;
  }

  private plainLine(): string {
    const segments: string[] = [`[${this.label}]`, this.phase || 'working'];
    segments.push(`elapsed ${formatDuration(this.elapsed())}`);
    if (this.bar) segments.push(renderBar(this.bar, 16));
    for (const [key, value] of this.metrics) segments.push(`${key} ${formatValue(value)}`);
    return segments.join(' | ');
  }

  private render(force = false): void {
    const t = now();
    if (!this.tty) {
      if (!force && t - this.lastPlainAt < this.plainIntervalMs) return;
      this.lastPlainAt = t;
      this.stream.write(`${this.plainLine()}\n`);
      return;
    }
    if (!force && t - this.lastRenderAt < this.minIntervalMs) return;
    this.lastRenderAt = t;
    const lines = this.frame();
    let out = '';
    if (this.frameLines > 0) out += `\x1b[${this.frameLines}A`;
    out += '\x1b[0J';
    out += `${lines.join('\n')}\n`;
    this.stream.write(out);
    this.frameLines = lines.length;
  }

  private startHeartbeat(): void {
    if (!this.tty || this.heartbeat) return;
    this.heartbeat = setInterval(() => this.render(true), this.heartbeatMs);
    // Never keep the process alive just for the heartbeat.
    (this.heartbeat as unknown as { unref?: () => void }).unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}
