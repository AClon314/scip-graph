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
</script>

<div class="panel graph">
  <div class="panel-title">call graph</div>
  <svg {viewBox} preserveAspectRatio="xMidYMid meet">
    {#each scene.edges as e (e.id)}
      <polyline
        points={e.points.map((p) => `${p.x},${p.y}`).join(' ')}
        fill="none"
        stroke={e.dimmed ? '#565f89' : e.color}
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
          fill="#1f2335"
          stroke={n.selected ? '#f7768e' : n.color}
          stroke-width={n.selected ? 3 : 1.5}
        />
        <text
          x={midX(n.x, n.width)}
          y={n.y + n.height / 2 + 5}
          text-anchor="middle"
          fill={n.color}
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
        <span class="swatch" style="background: {item.color}"></span>
        <span>{item.label}</span>
      </div>
    {/each}
  </div>
</div>
