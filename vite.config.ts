import { sveltekit } from '@sveltejs/kit/vite';
import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vite';

// GUI 宿主：SvelteKit（配置经插件传入，SvelteKit 3 不再读 svelte.config.js）。
// TUI（src/tui/main.ts）是独立的 bun 入口，不经这里打包。
export default defineConfig({
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      // 纯客户端渲染：静态导出 SPA 外壳（index.html fallback）。
      adapter: adapter({ fallback: 'index.html' }),
    }),
  ],
  server: { host: true, port: 5199, strictPort: true },
});
