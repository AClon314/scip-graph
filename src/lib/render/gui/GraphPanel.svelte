<script lang="ts">
  import type { GraphScene, LegendItem } from '../../core/model';

  let {
    scene,
    legend,
    onpick,
  }: {
    scene: GraphScene;
    legend: LegendItem[];
    onpick: (id: string) => void;
  } = $props();

  const pad = 12;
  const viewBox = $derived(
    `${scene.bounds.x - pad} ${scene.bounds.y - pad} ${scene.bounds.width + pad * 2} ${scene.bounds.height + pad * 2}`,
  );
  const midX = (x: number, w: number) => x + w / 2;

  // 颜色一律走 CSS 变量，随主题切换（core 里的 hex 只用于 TUI）。
  const KIND_VAR: Record<string, string> = {
    class: 'var(--class)',
    function: 'var(--fn)',
    method: 'var(--method)',
    module: 'var(--virtual)',
    dir: 'var(--dir)',
    file: 'var(--file)',
  };
  const colorOf = (kind: string | undefined) => KIND_VAR[kind ?? ''] ?? 'var(--fg)';
  const edgeColor = (e: GraphScene['edges'][number]) =>
    e.dimmed
      ? 'var(--dim)'
      : e.dashed
        ? 'var(--virtual)'
        : e.dispatch === 'self'
          ? 'var(--accent)'
          : 'var(--edge)';
</script>

<div class="panel graph">
  <div class="panel-title">call graph</div>
  <svg {viewBox} preserveAspectRatio="xMidYMid meet">
    {#each scene.edges as e (e.id)}
      <polyline
        points={e.points.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke={edgeColor(e)}
        stroke-width="2"
        stroke-dasharray={e.dashed ? '6 4' : undefined}
        opacity={e.dimmed ? 0.35 : 1}
      />
    {/each}
    {#each scene.nodes as n (n.id)}
      <g
        onclick={() => onpick(n.id)}
        onkeydown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onpick(n.id);
          }
        }}
        style="cursor: pointer"
        opacity={n.dimmed ? 0.3 : 1}
        role="button"
        tabindex="0"
      >
        <rect
          x={n.x}
          y={n.y}
          width={n.width}
          height={n.height}
          rx="6"
          fill="var(--raised)"
          stroke={n.selected ? 'var(--accent)' : colorOf(n.kind)}
          stroke-width={n.selected ? 3 : 1.5}
        />
        <text
          x={midX(n.x, n.width)}
          y={n.y + n.height / 2 + 5}
          text-anchor="middle"
          fill={colorOf(n.kind)}
          font-size="14"
        >
          {n.label.length > 22 ? n.label.slice(0, 21) + '…' : n.label}
        </text>
      </g>
    {/each}
  </svg>

  <div class="legend">
    {#each legend as item (item.kind)}
      <div class="item">
        <span class="swatch" style="background: {colorOf(item.kind)}"></span>
        <span>{item.label}</span>
      </div>
    {/each}
  </div>
</div>
