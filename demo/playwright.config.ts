import { defineConfig, devices } from "@playwright/test";

const publishedDemoUrl = process.env.PUBLISHED_DEMO_URL;
const published = publishedDemoUrl !== undefined;
if (published && publishedDemoUrl !== "https://mithundas79.github.io/filing-agent/") {
  throw new Error("PUBLISHED_DEMO_URL must be https://mithundas79.github.io/filing-agent/");
}

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.pw.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : undefined,
  outputDir: published ? "test-results-live" : "test-results",
  reporter: [["list"], ["html", { open: "never", outputFolder: published ? "playwright-report-live" : "playwright-report" }]],
  use: {
    baseURL: publishedDemoUrl ?? "http://127.0.0.1:4173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] } },
  ],
  webServer: published ? undefined : {
    command: "npm run build && npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173/filing-agent/",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
