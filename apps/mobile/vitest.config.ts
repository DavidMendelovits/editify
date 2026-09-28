import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the app's pure logic: the parts that decide what happens
 * (share routing, media rules, sync messages, the share-extension patch) and
 * need no simulator. Screens and native modules are exercised on a device.
 */
export default defineConfig({
  resolve: {
    alias: {
      // Same resolution Metro uses (the package's source), so tests need no shared build.
      '@editify/shared': decodeURIComponent(new URL('../../packages/shared/src/index.ts', import.meta.url).pathname),
    },
  },
  test: {
    environment: 'node',
    // Not under app/: expo-router would treat a test file there as a screen.
    include: ['src/**/*.test.ts', 'plugins/**/*.test.ts'],
  },
});
