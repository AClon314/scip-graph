<script lang="ts">
  let {
    value,
    placeholder,
    oninput,
    onfocus,
  }: {
    value: string;
    placeholder: string;
    oninput: (v: string) => void;
    onfocus: () => void;
  } = $props();
</script>

<div class="inputbar">
  <span class="prompt">&gt;</span>
  <input
    {value}
    {placeholder}
    oninput={(e) => oninput((e.currentTarget as HTMLInputElement).value)}
    {onfocus}
  />
</div>
