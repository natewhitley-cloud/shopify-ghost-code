import tsconfigPaths from "vite-tsconfig-paths";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      include: ["app/**/*.{ts,tsx}", "inngest/**/*.ts"],
      exclude: ["**/*.d.ts", "app/**/+types/**", ".react-router/**", "app/entry.*.tsx"],
    },
  },
});
