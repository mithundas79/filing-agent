import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/filing-agent/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Let a model suggest.Let the rules decide.");
});

test("navigate the actual recorded steps, inspect arguments and reset with keyboard controls", async ({ page }) => {
  await expect(page.getByTestId("step-progress")).toHaveText("Step 1 of 3");
  await expect(page.getByRole("button", { name: /Previous step/ })).toBeDisabled();
  await page.getByRole("button", { name: /Next step/ }).click();
  await expect(page.getByTestId("step-progress")).toHaveText("Step 2 of 3");
  await expect(page.getByRole("heading", { name: "See the choices", exact: true })).toBeVisible();
  await expect(page.locator("#step-detail")).toContainText("supplier-invoices");
  await page.getByRole("button", { name: /Next step/ }).click();
  await expect(page.getByRole("heading", { name: "Check the proposal", exact: true })).toBeVisible();
  await expect(page.getByText("Evidence check passes", { exact: true })).toBeVisible();
  await expect(page.getByText("Human review required", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Next step/ })).toBeDisabled();
  await page.getByText("Inspect recorded arguments", { exact: true }).click();
  await expect(page.locator(".call-arguments pre")).toContainText('"confidence": 0.95');
  const first = page.getByRole("button", { name: /Read the source/ });
  await first.focus(); await page.keyboard.press("Enter");
  await expect(first).toHaveAttribute("aria-current", "step");
  await expect(page.getByTestId("step-progress")).toHaveText("Step 1 of 3");
  await page.getByRole("button", { name: /Check the proposal/ }).click();
  const reset = page.getByRole("button", { name: /Reset walkthrough/ });
  await reset.focus(); await page.keyboard.press("Enter");
  await expect(page.getByTestId("step-progress")).toHaveText("Step 1 of 3");
});

test("real shared evidence validation rejects an invented quote, accepts a grounded quote and resets", async ({ page }) => {
  const evidence = page.getByLabel("Evidence quote to check");
  await page.getByRole("button", { name: "Try invented total" }).click();
  await expect(evidence).toHaveValue("Total Due 999.99");
  await page.getByRole("button", { name: "Check quote", exact: true }).click();
  await expect(page.getByText("Quote rejected", { exact: true })).toBeVisible();
  await expect(page.locator(".experiment-feedback")).toContainText("quote not found in the document");
  await page.getByRole("button", { name: "Use document quote" }).click();
  await page.getByRole("button", { name: "Check quote", exact: true }).click();
  await expect(page.getByText("Quote supported by the document", { exact: true })).toBeVisible();
  await evidence.fill("");
  await page.getByRole("button", { name: "Check quote", exact: true }).click();
  await expect(page.locator(".experiment-feedback")).toContainText("every evidence entry must be a nonempty string");
  await page.getByRole("button", { name: /Reset walkthrough/ }).click();
  await expect(evidence).toHaveValue("Total Due 677.04");
  await expect(page.locator(".experiment-feedback")).toContainText("Ready to check");
  await expect(page.getByText("Quote rejected", { exact: true })).toHaveCount(0);
});

test("explains the product boundary, expands technical details and links matching installation/source", async ({ page }) => {
  await page.getByText("Technical details and limits", { exact: true }).click();
  await expect(page.locator(".technical-details")).toContainText("does not execute the full agent controller");
  await expect(page.locator(".technical-details")).toContainText("No live inference, upload, OCR, file move");
  await page.getByRole("link", { name: "Run it locally", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Run the complete project.", exact: true })).toBeInViewport();
  await expect(page.getByLabel("Local installation commands")).toContainText("git clone --branch main");
  await expect(page.getByRole("link", { name: /Installation, tests and limits/ })).toHaveAttribute("href", /blob\/main\/README.md$/);
  await expect(page.getByRole("link", { name: "Source code", exact: true })).toHaveAttribute("href", /tree\/main$/);
  await expect(page.getByRole("link", { name: "Review app guide", exact: true })).toHaveAttribute("href", /doc-intake-service\/blob\/main\/README.md#try-the-guided-preview$/);
});

test("built page has no horizontal overflow, broken local assets, control characters or provider requests", async ({ page }) => {
  const failures: string[] = [];
  page.on("pageerror", (error) => failures.push(error.message));
  page.on("response", (response) => { if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`); });
  const external: string[] = [];
  page.on("request", (request) => { if (new URL(request.url()).origin !== "http://127.0.0.1:4173") external.push(request.url()); });
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByRole("button", { name: /Check the proposal/ }).click();
  await page.getByRole("button", { name: "Try invented total" }).click();
  await page.getByRole("button", { name: "Check quote", exact: true }).click();
  const dimensions = await page.evaluate(() => ({ width: document.documentElement.clientWidth, content: document.documentElement.scrollWidth }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.width + 1);
  expect(await page.locator("body").innerText()).not.toMatch(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/);
  const scripts = await page.locator("script[src]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
  expect(scripts.every((src) => src?.startsWith("/filing-agent/assets/"))).toBe(true);
  expect(failures).toEqual([]);
  expect(external).toEqual([]);
});

test("capture the built guided walkthrough for visual review", async ({ page }, testInfo) => {
  await page.getByRole("button", { name: /Check the proposal/ }).click();
  await expect(page.getByText("Human review required", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Try invented total" }).click();
  await page.getByRole("button", { name: "Check quote", exact: true }).click();
  await expect(page.getByText("Quote rejected", { exact: true })).toBeVisible();
  const image = testInfo.outputPath(`${testInfo.project.name}-guided-walkthrough.png`);
  await page.screenshot({ path: image, fullPage: true, animations: "disabled" });
  await testInfo.attach(`${testInfo.project.name} guided walkthrough`, { path: image, contentType: "image/png" });
});
