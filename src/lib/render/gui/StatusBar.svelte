<script lang="ts">
  import type { StatusSegment } from '../../core/model';

  let { segments, focus }: { segments: StatusSegment[]; focus: string } = $props();
</script>

<div class="status">
  {#each segments as seg}
    <span style="color: {seg.color ?? 'inherit'}">{seg.text}</span>
  {/each}
  <span class="focus">focus: {focus}</span>
</div>
