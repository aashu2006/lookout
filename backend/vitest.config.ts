import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // checker.ts imports config, which fail-fasts on missing env vars. Supplying
    // them here keeps the suite runnable without a local .env (e.g. in CI).
    // dotenv does not override already-set vars, so these win.
    env: {
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://lookout:lookout@localhost:5432/lookout",
      REDIS_URL: "redis://localhost:6379",
      JWT_SECRET: "test-only-secret-at-least-32-characters",
    },
  },
});
