import { defineConfig } from "vitest/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  test: { environment: "node" },
  resolve: {
    alias: {
      "@mai-chat/shared-types": path.resolve(dirname, "../../packages/shared-types/src/index.ts"),
      "@mai-chat/db": path.resolve(dirname, "../../packages/db/src/index.ts"),
      "@mai-chat/integrations": path.resolve(dirname, "../../packages/integrations/src/index.ts"),
    },
  },
});
