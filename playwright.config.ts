import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "*.spec.ts",
  fullyParallel: true,
  workers: process.env.CI ? 1 : "50%",
  globalTimeout: 120_000,
  timeout: 30_000,
  use: { baseURL: "http://127.0.0.1:4173", channel: "chrome" },
  webServer: {
    timeout: 20_000,
    command: "npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
  },
});
