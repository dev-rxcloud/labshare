import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  test: { include: ["tests/**/*.test.ts"], environment: "node", setupFiles: ["tests/setup.ts"], fileParallelism: false, testTimeout: 60000, hookTimeout: 120000 },
});
