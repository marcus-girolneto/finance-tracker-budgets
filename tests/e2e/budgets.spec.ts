import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, type Page } from "./fixtures";

const receiptImage = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "images",
  "receipt-test.png",
);

const today = new Date().toISOString().slice(0, 10);
const lastMonth = (() => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15))
    .toISOString()
    .slice(0, 10);
})();

async function addBudget(page: Page, category: string, limit: string) {
  await page.getByRole("banner").getByRole("button", { name: "Add Budget" }).click();
  const dialog = page.getByRole("dialog", { name: "Add Budget" });
  await dialog.getByLabel("Category").selectOption({ label: category });
  await dialog.getByLabel("Monthly limit").fill(limit);
  await dialog.getByRole("button", { name: "Create Budget" }).click();
}

function budgetRow(page: Page, category: string) {
  return page.getByTestId("budget-row").filter({ hasText: category });
}

async function addTransaction(
  page: Page,
  opts: { date: string; description: string; amount: string; category: string; isIncome?: boolean },
) {
  await page.goto("/transactions");
  await page.getByRole("banner").getByRole("button", { name: "Add Transaction" }).click();
  const modal = page.getByRole("dialog", { name: "New Transaction" });
  await modal.getByLabel("Date").fill(`${opts.date}T12:00`);
  await modal.getByLabel("Description").fill(opts.description);
  await modal.getByRole("spinbutton", { name: "Amount", exact: true }).fill(opts.amount);
  await modal.getByLabel("Account").selectOption({ index: 1 });
  await modal.getByLabel("Category").selectOption({ label: opts.category });
  if (opts.isIncome) await modal.getByLabel("Income").check();
  await modal.getByRole("button", { name: "Create Transaction" }).click();
  await expect(modal).toBeHidden();
}

async function budgetEmails(page: Page, username: string) {
  const res = await page.request.get(`/test-emails?to=${username}@example.com`);
  const { emails } = (await res.json()) as { emails: Array<{ subject: string; text: string }> };
  return emails.filter((e) => e.subject.includes("budget"));
}

test.describe("Budgets page", () => {
  test.beforeEach(async ({ page, signedInUser: _signedInUser }) => {
    await page.goto("/budgets");
  });

  test("is reachable from the main navigation and starts empty", async ({ page }) => {
    await page.goto("/dashboard");
    await page.getByRole("link", { name: "Budgets" }).click();
    await expect(page).toHaveURL("/budgets");
    await expect(page.getByRole("heading", { name: "Budgets", exact: true })).toBeVisible();
    await expect(page.getByText("No budgets yet")).toBeVisible();
    await expect(page.getByTestId("budgets-usage")).toHaveText("0 of 3 budgets on the Free plan");
  });

  test("adds a budget, changes its limit and removes it", async ({ page }) => {
    await addBudget(page, "Groceries", "500");

    const row = budgetRow(page, "Groceries");
    await expect(row.getByTestId("budget-limit")).toHaveText("500.00 PLN");
    await expect(row.getByTestId("budget-spent")).toHaveText("0.00 PLN");
    await expect(row.getByTestId("budget-left")).toHaveText("500.00 PLN");
    await expect(row.getByTestId("budget-over")).toBeHidden();

    await row.getByTestId("edit-budget").click();
    const dialog = page.getByRole("dialog", { name: "Edit budget" });
    await expect(dialog.getByLabel("Monthly limit")).toHaveValue("500");
    await dialog.getByLabel("Monthly limit").fill("750.50");
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toBeHidden();
    await expect(row.getByTestId("budget-limit")).toHaveText("750.50 PLN");

    await row.getByTestId("delete-budget").click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(budgetRow(page, "Groceries")).toBeHidden();
    await expect(page.getByText("No budgets yet")).toBeVisible();
  });

  test("validates the form before submitting", async ({ page }) => {
    await page.getByRole("banner").getByRole("button", { name: "Add Budget" }).click();
    const dialog = page.getByRole("dialog", { name: "Add Budget" });

    await dialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Choose a category.");

    await dialog.getByLabel("Category").selectOption({ label: "Groceries" });
    await dialog.getByLabel("Monthly limit").fill("0");
    await dialog.getByRole("button", { name: "Create Budget" }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Enter a limit greater than zero.");
  });

  test("hides categories that already have a budget from the picker", async ({ page }) => {
    await addBudget(page, "Groceries", "100");
    await expect(budgetRow(page, "Groceries")).toBeVisible();

    await page.getByRole("banner").getByRole("button", { name: "Add Budget" }).click();
    const options = page.getByRole("dialog", { name: "Add Budget" }).getByLabel("Category").locator("option");
    await expect(options.filter({ hasText: /^Groceries$/ })).toHaveCount(0);
    await expect(options.filter({ hasText: "Groceries › Vegetables" })).toHaveCount(1);
  });
});

test.describe("Budget spending", () => {
  test("counts subcategory spending, ignores income and other months, flags over budget and emails once", async ({
    page,
    signedInUser,
  }) => {
    await page.goto("/budgets");
    await addBudget(page, "Groceries", "100");
    await expect(budgetRow(page, "Groceries")).toBeVisible();

    await addTransaction(page, { date: today, description: "Veg market", amount: "60", category: "— Vegetables" });
    await addTransaction(page, { date: today, description: "Refund", amount: "500", category: "Groceries", isIncome: true });
    await addTransaction(page, { date: lastMonth, description: "Old shop", amount: "1000", category: "Groceries" });
    await addTransaction(page, { date: today, description: "Supermarket", amount: "50", category: "Groceries" });

    await page.goto("/budgets");
    const row = budgetRow(page, "Groceries");
    await expect(row.getByTestId("budget-spent")).toHaveText("110.00 PLN");
    await expect(row.getByTestId("budget-left")).toHaveText("Over by 10.00 PLN");
    await expect(row.getByTestId("budget-over")).toHaveText("Over budget");

    await expect.poll(async () => (await budgetEmails(page, signedInUser.username)).length).toBe(1);
    const [email] = await budgetEmails(page, signedInUser.username);
    expect(email.subject).toContain("Groceries");
    expect(email.text).toContain("110.00");

    await addTransaction(page, { date: today, description: "Snack", amount: "5", category: "Groceries" });
    await page.goto("/budgets");
    await expect(budgetRow(page, "Groceries").getByTestId("budget-spent")).toHaveText("115.00 PLN");
    await expect.poll(async () => (await budgetEmails(page, signedInUser.username)).length).toBe(1);
  });

  test("deleting a budgeted category removes its budget", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/categories");
    await page.getByRole("button", { name: "Add Category" }).click();
    await page.getByLabel("Name").fill("Budgeted Temp");
    await page.getByRole("button", { name: "Create Category" }).click();
    await expect(page.locator("main").getByText("Budgeted Temp")).toBeVisible();

    await page.goto("/budgets");
    await addBudget(page, "Budgeted Temp", "200");
    await expect(budgetRow(page, "Budgeted Temp")).toBeVisible();

    await page.goto("/categories");
    await page.getByRole("row").filter({ hasText: "Budgeted Temp" }).getByRole("button", { name: "Delete" }).click();
    await page
      .getByRole("alertdialog", { name: "Delete Category" })
      .getByRole("button", { name: "Delete" })
      .click();
    await expect(page.locator("main").getByText("Budgeted Temp")).toBeHidden();

    await page.goto("/budgets");
    await expect(budgetRow(page, "Budgeted Temp")).toBeHidden();
    await expect(page.getByText("No budgets yet")).toBeVisible();
  });
  test("a scanned receipt saved as a new transaction counts as spending", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/budgets");
    await addBudget(page, "Groceries", "30");
    await expect(budgetRow(page, "Groceries")).toBeVisible();

    await page.goto("/receipts/scan");
    await page.getByTestId("file-input").setInputFiles(receiptImage);
    await expect(page.getByTestId("store-name-input")).toHaveValue("FAKE_STORE");
    await page.getByTestId("save-receipt-btn").click();
    await expect(page.getByText("Receipt saved successfully!")).toBeVisible();

    await page.goto("/budgets");
    const row = budgetRow(page, "Groceries");
    await expect(row.getByTestId("budget-spent")).toHaveText("36.99 PLN");
    await expect(row.getByTestId("budget-left")).toHaveText("Over by 6.99 PLN");
  });
});

test.describe("Budget plan limits", () => {
  test("free users can hold 3 budgets and get an upgrade hint on the fourth", async ({
    page,
    signedInUser: _signedInUser,
  }) => {
    await page.goto("/budgets");
    for (const category of ["Groceries", "Housing", "Transport"]) {
      await addBudget(page, category, "100");
      await expect(budgetRow(page, category)).toBeVisible();
    }
    await expect(page.getByTestId("budgets-usage")).toContainText("3 of 3 budgets on the Free plan");
    await expect(page.getByRole("link", { name: "Upgrade to Pro for unlimited budgets" })).toBeVisible();

    await addBudget(page, "Health", "100");
    await expect(
      page.getByRole("dialog", { name: "Add Budget" }).getByRole("alert"),
    ).toHaveText("The free plan is limited to 3 budgets. Upgrade to Pro for unlimited budgets.");
    await page.getByRole("dialog", { name: "Add Budget" }).getByRole("button", { name: "Cancel" }).click();
    await expect(budgetRow(page, "Health")).toBeHidden();

    await page.goto("/billing");
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText("3 of 3 budgets");
  });

  test("pro users can create unlimited budgets", async ({ page, signedInUser: _signedInUser }) => {
    await page.request.post("/test-set-plan?plan=pro");
    await page.goto("/budgets");
    for (const category of ["Groceries", "Housing", "Transport", "Health"]) {
      await addBudget(page, category, "100");
      await expect(budgetRow(page, category)).toBeVisible();
    }
    await expect(page.getByTestId("budgets-usage")).toHaveText("4 budgets (unlimited)");

    await page.goto("/billing");
    await expect(page.getByTestId("billing-budgets-usage")).toHaveText("4 budgets (unlimited)");
  });
});
