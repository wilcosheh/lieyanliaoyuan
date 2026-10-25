import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  root: resolve(import.meta.dirname, ".."),
  cacheDir: resolve(import.meta.dirname, "node_modules/.vite"),
  test: {
    include: ["web/tests/**/*.test.ts"],
    environment: "jsdom",
    setupFiles: ["web/vitest.setup.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "web/coverage",
      reporter: ["text", "json-summary"],
      thresholds: { lines: 80, functions: 80, statements: 80, branches: 70 },
      include: [
        "src/adapter/http/battle_application.ts",
        "src/adapter/http/battle_view.ts",
        "src/adapter/http/lobby/repository.ts",
        "src/speech/qiniu_provider.ts",
        "web/src/audio/browser-speech-recognizer.ts",
        "web/src/audio/wav-recorder.ts",
      ],
      exclude: ["**/*.d.ts"],
    },
  },
});
