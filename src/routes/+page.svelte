<script lang="ts">
  import { buildAppVM, layoutScreen, type AppState } from '../lib/core/model';
  import { fromIR } from '../lib/core/from-ir';
  import { mockLayeredGraph } from '../lib/ir/mock';
  import FileTree from '../lib/render/gui/FileTree.svelte';
  import GraphPanel from '../lib/render/gui/GraphPanel.svelte';
  import StatusBar from '../lib/render/gui/StatusBar.svelte';
  import InputBar from '../lib/render/gui/InputBar.svelte';

  // 与 TUI 完全相同的 IR → view-model 构建器；只有「光栅化」不同。
  const graph = fromIR(mockLayeredGraph);
  const layout = layoutScreen(120, 34);

  let fold = $state<Set<string>>(new Set());
  let selectedId = $state<string | null>(graph.nodes[1]?.id ?? null);
  let inputValue = $state('');
  let focus = $state<AppState['focus']>('graph');

  const vm = $derived(buildAppVM({ graph, fold, selectedId, inputValue, focus }));

  function toggle(id: string) {
    const next = new Set(fold);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    fold = next;
  }
</script>

<div class="app">
  <div class="header">
    scip-graph <span class="sub">ir → vm (sveltekit)</span>
  </div>

  <div class="body">
    <FileTree
      rows={vm.rows}
      widthCells={layout.tree.width}
      onpick={(id) => (selectedId = id)}
      ontoggle={toggle}
    />
    <GraphPanel scene={vm.scene} legend={vm.legend} onpick={(id) => (selectedId = id)} />
  </div>

  <StatusBar segments={vm.status} focus={vm.focus} />
  <InputBar
    value={inputValue}
    placeholder={vm.input.placeholder}
    oninput={(v) => (inputValue = v)}
    onfocus={() => (focus = 'input')}
  />
</div>
