// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { db, schema } from "#/db";
import {
  budgetMonth,
  countBudgets,
  createBudget,
  deleteBudget,
  getBudgetStatuses,
  notifyOverBudgets,
  updateBudgetLimit,
} from "#/server/budgets.server";
import { hardDeleteUser } from "#/server/compliance.server";
import { env } from "#/server/env";
import type { EmailMessage } from "#/server/email";

const NOW = new Date("2026-03-15T12:00:00Z");
const NEXT_MONTH = new Date("2026-04-02T08:00:00Z");

const createdUsers: string[] = [];
let sequence = 0;

afterEach(async () => {
  for (const userId of createdUsers.splice(0).reverse()) {
    await hardDeleteUser(userId);
  }
});

async function seedUser(options: { verified?: boolean; email?: boolean } = {}) {
  const userId = `budget-user-${++sequence}-${crypto.randomUUID().slice(0, 8)}`;
  createdUsers.push(userId);
  await db.insert(schema.users).values({
    id: userId,
    username: userId,
    email: options.email === false ? null : `${userId}@example.com`,
    email_verified_at: options.verified === false ? null : new Date(),
    password_hash: "x",
  });
  await db.insert(schema.accounts).values({
    id: `${userId}-acc`,
    user_id: userId,
    name: "Main",
  });
  return userId;
}

async function seedCategory(userId: string, name: string, parentId: string | null = null) {
  const id = `${userId}-${name}`;
  await db.insert(schema.categories).values({
    id,
    user_id: userId,
    name,
    parent_id: parentId,
  });
  return id;
}

async function seedTransaction(
  userId: string,
  amountMinor: number,
  date: string,
  categoryId: string | null,
) {
  await db.insert(schema.transactions).values({
    id: crypto.randomUUID(),
    user_id: userId,
    account_id: `${userId}-acc`,
    amount_minor: amountMinor,
    date,
    category_id: categoryId,
  });
}

async function setPlan(userId: string, plan: "free" | "pro", status = "active") {
  await db.insert(schema.subscriptions).values({ user_id: userId, plan, status });
}

async function createOk(userId: string, categoryId: string, limitMinor: number) {
  const result = await createBudget(userId, { categoryId, limitMinor });
  if (!("success" in result)) throw new Error(`unexpected ${result.code}`);
  return result.id;
}

function recordingSender() {
  const sent: EmailMessage[] = [];
  const send = vi.fn(async (message: EmailMessage) => {
    sent.push(message);
  });
  return { sent, send };
}

describe("budgetMonth", () => {
  it.each([
    ["2026-03-15T12:00:00Z", { month: "2026-03", from: "2026-03-01", to: "2026-04-01" }],
    ["2026-12-31T23:59:59Z", { month: "2026-12", from: "2026-12-01", to: "2027-01-01" }],
    ["2028-02-29T00:00:00Z", { month: "2028-02", from: "2028-02-01", to: "2028-03-01" }],
    ["2026-01-01T00:00:00Z", { month: "2026-01", from: "2026-01-01", to: "2026-02-01" }],
  ])("maps %s to its UTC calendar month", (iso, expected) => {
    expect(budgetMonth(new Date(iso))).toEqual(expected);
  });
});

describe("getBudgetStatuses", () => {
  it("returns an empty list for a user without budgets", async () => {
    const userId = await seedUser();
    expect(await getBudgetStatuses(userId, NOW)).toEqual([]);
  });

  it("rolls up spending from all descendant categories, ignoring income, other months, other categories and other users", async () => {
    const userId = await seedUser();
    const otherUser = await seedUser();
    const food = await seedCategory(userId, "Food");
    const groceries = await seedCategory(userId, "Groceries", food);
    const organic = await seedCategory(userId, "Organic", groceries);
    const fun = await seedCategory(userId, "Fun");

    await seedTransaction(userId, -10_00, "2026-03-01", groceries);
    await seedTransaction(userId, -5_00, "2026-03-31", organic);
    await seedTransaction(userId, -2_00, "2026-03-10", food);
    await seedTransaction(userId, 3_00, "2026-03-11", groceries);
    await seedTransaction(userId, -99_99, "2026-02-28", groceries);
    await seedTransaction(userId, -1_00, "2026-04-01", groceries);
    await seedTransaction(userId, -50, "2026-03-12", fun);
    await seedTransaction(userId, -7_00, "2026-03-12", null);
    await seedTransaction(otherUser, -40_00, "2026-03-12", food);

    const foodBudget = await createOk(userId, food, 20_00);
    const groceriesBudget = await createOk(userId, groceries, 10_00);

    const statuses = await getBudgetStatuses(userId, NOW);
    expect(statuses).toEqual([
      expect.objectContaining({
        id: foodBudget,
        categoryName: "Food",
        limitMinor: 20_00,
        spentMinor: 17_00,
        remainingMinor: 3_00,
        overBudget: false,
      }),
      expect.objectContaining({
        id: groceriesBudget,
        categoryName: "Groceries",
        limitMinor: 10_00,
        spentMinor: 15_00,
        remainingMinor: -5_00,
        overBudget: true,
      }),
    ]);
  });

  it("treats spending exactly at the limit as not over budget", async () => {
    const userId = await seedUser();
    const food = await seedCategory(userId, "Food");
    await seedTransaction(userId, -25_00, "2026-03-05", food);
    await createOk(userId, food, 25_00);

    const [status] = await getBudgetStatuses(userId, NOW);
    expect(status).toMatchObject({ spentMinor: 25_00, remainingMinor: 0, overBudget: false });
  });

  it("resets every month", async () => {
    const userId = await seedUser();
    const food = await seedCategory(userId, "Food");
    await seedTransaction(userId, -30_00, "2026-03-05", food);
    await createOk(userId, food, 25_00);

    expect((await getBudgetStatuses(userId, NOW))[0].overBudget).toBe(true);
    expect((await getBudgetStatuses(userId, NEXT_MONTH))[0]).toMatchObject({
      spentMinor: 0,
      remainingMinor: 25_00,
      overBudget: false,
    });
  });

  it("terminates on a cyclic category graph and counts each category once", async () => {
    const userId = await seedUser();
    const a = await seedCategory(userId, "A");
    const b = await seedCategory(userId, "B", a);
    await db
      .update(schema.categories)
      .set({ parent_id: b })
      .where(eq(schema.categories.id, a));
    await seedTransaction(userId, -1_00, "2026-03-05", a);
    await seedTransaction(userId, -2_00, "2026-03-05", b);
    await createOk(userId, a, 10_00);

    expect((await getBudgetStatuses(userId, NOW))[0].spentMinor).toBe(3_00);
  });

  it("sums beyond the 32-bit integer range without overflow", async () => {
    const userId = await seedUser();
    const food = await seedCategory(userId, "Food");
    await seedTransaction(userId, -2_147_483_648, "2026-03-05", food);
    await seedTransaction(userId, -1_852_516_352, "2026-03-06", food);
    await createOk(userId, food, 1_00);

    expect((await getBudgetStatuses(userId, NOW))[0].spentMinor).toBe(4_000_000_000);
  });
});

describe("createBudget", () => {
  it("rejects a category owned by another user without revealing it", async () => {
    const userId = await seedUser();
    const otherUser = await seedUser();
    const foreign = await seedCategory(otherUser, "Food");

    expect(await createBudget(userId, { categoryId: foreign, limitMinor: 1_00 })).toMatchObject({
      code: "category_not_found",
    });
    expect(await countBudgets(userId)).toBe(0);
  });

  it("rejects a missing category", async () => {
    const userId = await seedUser();
    expect(
      await createBudget(userId, { categoryId: "does-not-exist", limitMinor: 1_00 }),
    ).toMatchObject({ code: "category_not_found" });
  });

  it("allows only one budget per category", async () => {
    const userId = await seedUser();
    const food = await seedCategory(userId, "Food");
    await createOk(userId, food, 1_00);

    expect(await createBudget(userId, { categoryId: food, limitMinor: 2_00 })).toMatchObject({
      code: "budget_exists",
    });
    expect(await countBudgets(userId)).toBe(1);
  });

  it("limits the free plan and reports the limit", async () => {
    const userId = await seedUser();
    const limit = env.billing.freeMaxBudgets;
    for (let i = 0; i < limit; i++) {
      await createOk(userId, await seedCategory(userId, `C${i}`), 1_00);
    }

    const blocked = await createBudget(userId, {
      categoryId: await seedCategory(userId, "Extra"),
      limitMinor: 1_00,
    });
    expect(blocked).toMatchObject({ code: "budget_limit_reached", limit });
    expect(await countBudgets(userId)).toBe(limit);
  });

  it("never exceeds the free limit under concurrent creates", async () => {
    const userId = await seedUser();
    const categories = await Promise.all(
      Array.from({ length: 6 }, (_, i) => seedCategory(userId, `Parallel${i}`)),
    );

    const results = await Promise.all(
      categories.map((categoryId) => createBudget(userId, { categoryId, limitMinor: 1_00 })),
    );

    expect(results.filter((r) => "success" in r)).toHaveLength(env.billing.freeMaxBudgets);
    expect(await countBudgets(userId)).toBe(env.billing.freeMaxBudgets);
  });

  it("is unlimited on Pro, including the past_due grace period", async () => {
    for (const status of ["active", "past_due"]) {
      const userId = await seedUser();
      await setPlan(userId, "pro", status);
      for (let i = 0; i < env.billing.freeMaxBudgets + 2; i++) {
        await createOk(userId, await seedCategory(userId, `Pro${i}`), 1_00);
      }
      expect(await countBudgets(userId)).toBe(env.billing.freeMaxBudgets + 2);
    }
  });

  it("keeps existing budgets after a downgrade but blocks new ones", async () => {
    const userId = await seedUser();
    await setPlan(userId, "pro");
    for (let i = 0; i < env.billing.freeMaxBudgets + 1; i++) {
      await createOk(userId, await seedCategory(userId, `Kept${i}`), 1_00);
    }
    await db
      .update(schema.subscriptions)
      .set({ plan: "free", status: "canceled" })
      .where(eq(schema.subscriptions.user_id, userId));

    expect(
      await createBudget(userId, {
        categoryId: await seedCategory(userId, "New"),
        limitMinor: 1_00,
      }),
    ).toMatchObject({ code: "budget_limit_reached" });
    expect(await getBudgetStatuses(userId, NOW)).toHaveLength(env.billing.freeMaxBudgets + 1);
  });
});

describe("updateBudgetLimit and deleteBudget", () => {
  it("changes the limit of an owned budget", async () => {
    const userId = await seedUser();
    const id = await createOk(userId, await seedCategory(userId, "Food"), 1_00);

    expect(await updateBudgetLimit(userId, { id, limitMinor: 50_00 })).toEqual({
      success: true,
      id,
    });
    expect((await getBudgetStatuses(userId, NOW))[0].limitMinor).toBe(50_00);
  });

  it("treats another user's budget as not found for update and delete", async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const id = await createOk(owner, await seedCategory(owner, "Food"), 1_00);

    expect(await updateBudgetLimit(attacker, { id, limitMinor: 9_99 })).toMatchObject({
      code: "budget_not_found",
    });
    expect(await deleteBudget(attacker, id)).toMatchObject({ code: "budget_not_found" });
    expect((await getBudgetStatuses(owner, NOW))[0].limitMinor).toBe(1_00);
  });

  it("deletes an owned budget and frees a plan slot", async () => {
    const userId = await seedUser();
    const id = await createOk(userId, await seedCategory(userId, "Food"), 1_00);

    expect(await deleteBudget(userId, id)).toEqual({ success: true, id });
    expect(await countBudgets(userId)).toBe(0);
    expect(await deleteBudget(userId, id)).toMatchObject({ code: "budget_not_found" });
  });
});

describe("notifyOverBudgets", () => {
  async function overBudgetUser(options?: { verified?: boolean; email?: boolean }) {
    const userId = await seedUser(options);
    const food = await seedCategory(userId, "Food");
    await createOk(userId, food, 10_00);
    await seedTransaction(userId, -12_50, "2026-03-05", food);
    return { userId, food };
  }

  it("emails once per budget per month with the spending figures", async () => {
    const { userId } = await overBudgetUser();
    const { sent, send } = recordingSender();

    expect(await notifyOverBudgets(userId, NOW, send)).toBe(1);
    expect(await notifyOverBudgets(userId, NOW, send)).toBe(0);

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(`${userId}@example.com`);
    expect(sent[0].subject).toContain("Food");
    expect(sent[0].text).toContain("12.50");
    expect(sent[0].text).toContain("10.00");
    expect(sent[0].text).toContain("2.50");
  });

  it("does not email while within budget", async () => {
    const userId = await seedUser();
    const food = await seedCategory(userId, "Food");
    await createOk(userId, food, 10_00);
    await seedTransaction(userId, -10_00, "2026-03-05", food);
    const { send } = recordingSender();

    expect(await notifyOverBudgets(userId, NOW, send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("does not email again after the limit is raised and exceeded again in the same month", async () => {
    const { userId, food } = await overBudgetUser();
    const { send } = recordingSender();
    await notifyOverBudgets(userId, NOW, send);

    const [status] = await getBudgetStatuses(userId, NOW);
    await updateBudgetLimit(userId, { id: status.id, limitMinor: 20_00 });
    await seedTransaction(userId, -10_00, "2026-03-20", food);

    expect(await notifyOverBudgets(userId, NOW, send)).toBe(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("does not email again when the budget is deleted and recreated in the same month", async () => {
    const { userId, food } = await overBudgetUser();
    const { send } = recordingSender();
    await notifyOverBudgets(userId, NOW, send);

    for (let i = 0; i < 3; i++) {
      const [status] = await getBudgetStatuses(userId, NOW);
      await deleteBudget(userId, status.id);
      await createOk(userId, food, 10_00);
      expect(await notifyOverBudgets(userId, NOW, send)).toBe(0);
    }
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("emails again in a new month once the budget is exceeded again", async () => {
    const { userId, food } = await overBudgetUser();
    const { send } = recordingSender();
    await notifyOverBudgets(userId, NOW, send);

    expect(await notifyOverBudgets(userId, NEXT_MONTH, send)).toBe(0);
    await seedTransaction(userId, -11_00, "2026-04-01", food);
    expect(await notifyOverBudgets(userId, NEXT_MONTH, send)).toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("sends exactly one email when evaluated concurrently", async () => {
    const { userId } = await overBudgetUser();
    const { send } = recordingSender();

    const counts = await Promise.all(
      Array.from({ length: 5 }, () => notifyOverBudgets(userId, NOW, send)),
    );

    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when sending fails so a later change retries", async () => {
    const { userId } = await overBudgetUser();
    const failing = vi.fn(async () => {
      throw new Error("provider down");
    });

    expect(await notifyOverBudgets(userId, NOW, failing)).toBe(0);
    expect(
      await db
        .select()
        .from(schema.budget_alerts)
        .where(eq(schema.budget_alerts.user_id, userId)),
    ).toHaveLength(0);

    const { send } = recordingSender();
    expect(await notifyOverBudgets(userId, NOW, send)).toBe(1);
  });

  it.each([
    ["an unverified email", { verified: false }],
    ["no email", { email: false }],
  ])("never emails a user with %s", async (_label, options) => {
    const { userId } = await overBudgetUser(options);
    const { send } = recordingSender();

    expect(await notifyOverBudgets(userId, NOW, send)).toBe(0);
    expect(send).not.toHaveBeenCalled();
  });

  it("alerts each over-budget budget independently", async () => {
    const { userId } = await overBudgetUser();
    const fun = await seedCategory(userId, "Fun");
    await createOk(userId, fun, 1_00);
    await seedTransaction(userId, -2_00, "2026-03-05", fun);
    const { sent, send } = recordingSender();

    expect(await notifyOverBudgets(userId, NOW, send)).toBe(2);
    expect(sent.map((m) => m.subject).sort()).toEqual([
      expect.stringContaining("Food"),
      expect.stringContaining("Fun"),
    ]);
  });

  it("uses the configured email provider by default", async () => {
    const { userId } = await overBudgetUser();
    const { getCapturedEmails } = await import("#/server/email");

    expect(await notifyOverBudgets(userId, NOW)).toBe(1);
    expect(getCapturedEmails(`${userId}@example.com`)).toHaveLength(1);
  });
});

describe("account hard delete", () => {
  it("removes budgets and alert history with the rest of the user's data", async () => {
    const userId = await seedUser();
    const food = await seedCategory(userId, "Food");
    await createOk(userId, food, 1_00);
    await seedTransaction(userId, -2_00, "2026-03-05", food);
    await notifyOverBudgets(userId, NOW, recordingSender().send);

    await hardDeleteUser(userId);

    expect(
      await db.select().from(schema.budgets).where(eq(schema.budgets.user_id, userId)),
    ).toHaveLength(0);
    expect(
      await db
        .select()
        .from(schema.budget_alerts)
        .where(eq(schema.budget_alerts.user_id, userId)),
    ).toHaveLength(0);
  });
});
