import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: { environment: "node" },
  resolve: {
    alias: {
      "@mai-chat/shared-types": path.resolve(dirname, "../shared-types/src/index.ts"),
    },
  },
});
