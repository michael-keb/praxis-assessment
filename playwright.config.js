import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:18124",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "node tests/start-brief-server.mjs",
    url: "http://127.0.0.1:18124/healthz",
    reuseExistingServer: false,
  },
});
