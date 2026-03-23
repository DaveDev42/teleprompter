import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 1,
  workers: 1,
  use: {
    baseURL: "http://localhost:8081",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "cd apps/app && npx expo start --web --port 8081",
    port: 8081,
    timeout: 60_000,
    reuseExistingServer: true,
  },
  projects: [
    {
      name: "ci",
      testMatch: ["app-web.spec.ts", "app-daemon.spec.ts"],
    },
    {
      name: "local",
      testMatch: ["*.spec.ts"],
    },
  ],
});
