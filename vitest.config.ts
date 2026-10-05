import { defineConfig } from 'vitest/config';
import path from 'path';
import { fileURLToPath } from 'url';

// ESM-native config directory: Vite 8 warns that `__dirname` stops working
// once its native config loader becomes the default.
const configDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/ui/**', 'src/electron/**'],
    },
  },
  resolve: {
    alias: {
      '@core': path.resolve(configDir, 'src/core'),
      '@monitors': path.resolve(configDir, 'src/monitors'),
      '@ui': path.resolve(configDir, 'src/ui'),
      '@api': path.resolve(configDir, 'src/api'),
    },
  },
});
