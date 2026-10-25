import { defineConfig } from 'tsup';

export default defineConfig([
  // The library: ESM and CJS, so CommonJS hosts can require the engine.
  {
    entry: { index: 'src/index.ts' },
    format: ['esm', 'cjs'],
    platform: 'node',
    target: 'node22',
    dts: true,
    sourcemap: true,
    clean: true,
  },
  // The CLI: ESM only, because @inquirer/prompts is.
  {
    entry: { cli: 'src/cli/bin.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
