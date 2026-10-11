<script lang="ts">
  import type { TreeRow } from '../../core/model';

  let {
    rows,
    widthCells,
    onpick,
    ontoggle,
  }: {
    rows: TreeRow[];
    widthCells: number;
    onpick: (id: string) => void;
    ontoggle: (id: string) => void;
  } = $props();

  const activate = (row: TreeRow) => {
    if (row.symbolId) onpick(row.symbolId);
    else ontoggle(row.id);
  };
</script>

<div class="panel tree" style="width: calc(var(--cw) * {widthCells})">
  <div class="panel-title">files</div>
  {#each rows as row (row.id)}
    <div
      class="row"
      class:dim={row.dimmed}
      style="--depth: {row.depth}"
      role="button"
      tabindex="0"
      onclick={() => activate(row)}
      onkeydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate(row);
        }
      }}
    >
      <span class="marker">{row.hasChildren ? (row.expanded ? 'v' : '›') : '─'}</span>
      <span class="label">{row.label}</span>
      {#if row.badge}<span class="badge">{row.badge}</span>{/if}
    </div>
  {/each}
</div>
