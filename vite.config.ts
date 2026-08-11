import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const storeBuild = process.env.OMNITOOLS_STORE_BUILD === 'true';

export default defineConfig({
  plugins: [react()],
  define: {
    __OMNITOOLS_STORE_BUILD__: JSON.stringify(storeBuild),
  },
  // Relative paths so assets load correctly under chrome-extension:// protocol
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    rollupOptions: {
      input: { panel: resolve(__dirname, 'panel.html') },
      output: {
        // Put all JS/CSS into dist/ directly (no assets/ subfolder confusion)
        entryFileNames: '[name].js',
        chunkFileNames: '[name]-[hash].js',
        assetFileNames: '[name][extname]',
      },
    },
  },
});
