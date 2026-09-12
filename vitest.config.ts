import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Integration tests boot a real (WASM) Postgres via PGlite and run
    // migrations against it in beforeAll; several test files doing that
    // concurrently comfortably exceeds vitest's 5s/10s defaults even
    // though any single one only takes ~3-4s in isolation.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
