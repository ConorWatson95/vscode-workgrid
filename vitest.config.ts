import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Unit tests only — these files never import the `vscode` module.
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
