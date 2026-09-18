import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    // Heavy tests (e.g. PDF rendering at the 250-finding cap) run ~2-3s in
    // isolation but can exceed the 5s default under parallel load, especially
    // on the 2-core CI runner. A generous timeout plus one retry keeps the
    // parallel suite fast while eliminating load-contention flakes. The suite
    // is deterministically green when run sequentially, so this masks machine
    // load, not real test failures (gc-3sb deploy preflight).
    testTimeout: 20000,
    retry: 1,
    coverage: {
      provider: "v8",
      include: ["app/**/*.{ts,tsx}", "inngest/**/*.ts"],
      exclude: ["**/*.d.ts", "app/**/+types/**", ".react-router/**", "app/entry.*.tsx"],
    },
  },
});
