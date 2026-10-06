import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("GPT-6.1 Sol appears in the subscription model picker", async ({ page }, testInfo) => {
  await signup(page, `current-models-${Date.now()}@rakazo.test`, "password12", "Model Picker");
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("OpenAI Codex");
  await page
    .getByTestId("model-settings")
    .getByRole("button")
    .filter({ hasText: "OpenAI Codex" })
    .first()
    .click();
  await page.getByRole("combobox", { name: "Model", exact: true }).click();
  await page.getByRole("combobox", { name: "Search models" }).fill("GPT-6.1 Sol");
  await expect(page.getByRole("option", { name: "GPT-6.1 Sol", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "model-sol-61");
});
