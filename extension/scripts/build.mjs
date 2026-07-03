// Bundles the service worker and options page into dist/, which is what gets
// loaded unpacked (chrome://extensions → "Load unpacked" → extension/dist).
import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

await build({
  entryPoints: {
    background: 'src/background/index.ts',
    options: 'src/ui/options.ts',
    popup: 'src/ui/popup.ts',
  },
  bundle: true,
  format: 'esm',
  target: 'chrome120',
  outdir: 'dist',
  sourcemap: false,
  logLevel: 'info',
});

mkdirSync('dist', { recursive: true });
copyFileSync('src/manifest.json', 'dist/manifest.json');
copyFileSync('src/ui/options.html', 'dist/options.html');
copyFileSync('src/ui/popup.html', 'dist/popup.html');
