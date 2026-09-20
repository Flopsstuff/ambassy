/**
 * The one configuration file in a repository that deliberately has no tsconfig.json.
 *
 * Vitest transforms TypeScript through esbuild, the same way `tsx` runs the servers, so
 * the imports here keep their `.ts` extensions and nothing is compiled to disk. What the
 * file exists for is the two lists below.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Transforming the sources is most of a run; the cache lives under node_modules/,
    // which is already ignored, so `yarn test:watch` stops redoing it every time.
    fsModuleCache: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // The entry points. Each one reads the environment, builds an Agent Card and binds
      // a port at import time, so "covering" them would mean starting a server — which is
      // what `yarn client` against a live agent already does, and does better. What they
      // are worth testing for now lives in the modules they import.
      exclude: ['src/agent.ts', 'src/acp/agent.ts', 'src/mcp/server.ts', 'src/client.ts', 'src/proxy.ts'],
      reporter: ['text', 'html'],
    },
  },
});
