import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Integration tests share one database when DATABASE_URL is set, so run files serially.
    fileParallelism: false,
  },
});
