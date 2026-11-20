import { defineConfig, devices } from "@playwright/test";

/**
 * Browser tests. Empty until M4 renders a screen worth driving; the suite
 * exists from M0 so the first real test has somewhere to go.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL: "http://localhost:3020",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:3020",
    reuseExistingServer: !process.env.CI,
  },
});
