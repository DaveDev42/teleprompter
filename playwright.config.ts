import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  workers: 1,
  use: {
    baseURL: "http://localhost:8081",
    headless: true,
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "npx serve apps/app/dist -p 8081 -s",
    port: 8081,
    timeout: 10_000,
    reuseExistingServer: true,
  },
  projects: [
    {
      name: "ci",
      retries: 0,
      testMatch: [
        "app-web.spec.ts",
        "app-settings.spec.ts",
        "app-keyboard-nav.spec.ts",
      ],
    },
    {
      name: "local",
      retries: 1,
      testMatch: ["*.spec.ts"],
    },
  ],
});
