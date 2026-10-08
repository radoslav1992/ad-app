import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(
        new URL("./tests/cloudflare-runtime.ts", import.meta.url),
      ),
    },
  },
  // Local agent worktrees (.claude/) hold other checkouts of this repo.
  test: { environment: "node", exclude: [...configDefaults.exclude, ".claude/**"] },
});
