import { and, asc, count, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import { db, schema } from "#/db";
import { formatMinor } from "#/lib/money";
import { m } from "#/paraglide/messages";
import { getEntitlements } from "#/server/billing.server";
import { categorySubtree, childrenByParent } from "#/server/categories.server";
import { sendEmail, type EmailMessage } from "#/server/email";
import { getLogger } from "#/server/logger";

export interface BudgetMonth {
  month: string;
  from: string;
  to: string;
}

export interface BudgetStatus {
  id: string;
  categoryId: string;
  categoryName: string;
  categoryColor: string | null;
  limitMinor: number;
  spentMinor: number;
  remainingMinor: number;
  overBudget: boolean;
}

export type BudgetErrorCode =
  | "category_not_found"
  | "budget_exists"
  | "budget_not_found"
  | "budget_limit_reached";

export type BudgetMutationResult =
  | { success: true; id: string }
  | { error: string; code: BudgetErrorCode; limit?: number };

export function budgetMonth(now: Date): BudgetMonth {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const isoDay = (date: Date) => date.toISOString().slice(0, 10);
  const from = isoDay(new Date(Date.UTC(year, monthIndex, 1)));
  const to = isoDay(new Date(Date.UTC(year, monthIndex + 1, 1)));
  return { month: from.slice(0, 7), from, to };
}

export async function getBudgetStatuses(
  userId: string,
  now: Date = new Date(),
): Promise<BudgetStatus[]> {
  const { from, to } = budgetMonth(now);

  const [budgets, categories, spending] = await Promise.all([
    db
      .select({
        id: schema.budgets.id,
        categoryId: schema.budgets.category_id,
        categoryName: schema.categories.name,
        categoryColor: schema.categories.color,
        limitMinor: schema.budgets.limit_minor,
      })
      .from(schema.budgets)
      .innerJoin(
        schema.categories,
        and(
          eq(schema.budgets.category_id, schema.categories.id),
          eq(schema.categories.user_id, userId),
        ),
      )
      .where(eq(schema.budgets.user_id, userId))
      .orderBy(asc(schema.categories.name), asc(schema.budgets.created_at)),
    db
      .select({
        id: schema.categories.id,
        parentId: schema.categories.parent_id,
      })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId)),
    db
      .select({
        categoryId: schema.transactions.category_id,
        spentMinor: sql<number>`-SUM(${schema.transactions.amount_minor})`.mapWith(Number),
      })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.user_id, userId),
          lt(schema.transactions.amount_minor, 0),
          gte(schema.transactions.date, from),
          lt(schema.transactions.date, to),
          isNotNull(schema.transactions.category_id),
        ),
      )
      .groupBy(schema.transactions.category_id),
  ]);

  const children = childrenByParent(categories);
  const spentByCategory = new Map(
    spending.map((row) => [row.categoryId, row.spentMinor]),
  );

  return budgets.map((budget) => {
    let spentMinor = 0;
    for (const id of categorySubtree(budget.categoryId, children)) {
      spentMinor += spentByCategory.get(id) ?? 0;
    }
    return {
      ...budget,
      spentMinor,
      remainingMinor: budget.limitMinor - spentMinor,
      overBudget: spentMinor > budget.limitMinor,
    };
  });
}

export async function countBudgets(userId: string): Promise<number> {
  const rows = await db
    .select({ count: count() })
    .from(schema.budgets)
    .where(eq(schema.budgets.user_id, userId));
  return rows[0]?.count ?? 0;
}

export async function createBudget(
  userId: string,
  input: { categoryId: string; limitMinor: number },
): Promise<BudgetMutationResult> {
  const { maxBudgets } = await getEntitlements(userId);

  return db.transaction(async (tx): Promise<BudgetMutationResult> => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for("update");

    const category = await tx
      .select({ id: schema.categories.id })
      .from(schema.categories)
      .where(
        and(
          eq(schema.categories.id, input.categoryId),
          eq(schema.categories.user_id, userId),
        ),
      )
      .limit(1);
    if (category.length === 0) {
      return { error: "Category does not exist", code: "category_not_found" };
    }

    if (maxBudgets !== null) {
      const [existing] = await tx
        .select({ count: count() })
        .from(schema.budgets)
        .where(eq(schema.budgets.user_id, userId));
      if ((existing?.count ?? 0) >= maxBudgets) {
        return {
          error: `Free plan is limited to ${maxBudgets} budgets. Upgrade to Pro for unlimited budgets.`,
          code: "budget_limit_reached",
          limit: maxBudgets,
        };
      }
    }

    const inserted = await tx
      .insert(schema.budgets)
      .values({
        id: crypto.randomUUID(),
        user_id: userId,
        category_id: input.categoryId,
        limit_minor: input.limitMinor,
      })
      .onConflictDoNothing({
        target: [schema.budgets.user_id, schema.budgets.category_id],
      })
      .returning({ id: schema.budgets.id });
    if (inserted.length === 0) {
      return { error: "This category already has a budget", code: "budget_exists" };
    }
    return { success: true, id: inserted[0].id };
  });
}

export async function updateBudgetLimit(
  userId: string,
  input: { id: string; limitMinor: number },
): Promise<BudgetMutationResult> {
  const updated = await db
    .update(schema.budgets)
    .set({ limit_minor: input.limitMinor, updated_at: new Date() })
    .where(
      and(eq(schema.budgets.id, input.id), eq(schema.budgets.user_id, userId)),
    )
    .returning({ id: schema.budgets.id });
  if (updated.length === 0) {
    return { error: "Budget not found", code: "budget_not_found" };
  }
  return { success: true, id: input.id };
}

export async function deleteBudget(
  userId: string,
  id: string,
): Promise<BudgetMutationResult> {
  const deleted = await db
    .delete(schema.budgets)
    .where(and(eq(schema.budgets.id, id), eq(schema.budgets.user_id, userId)))
    .returning({ id: schema.budgets.id });
  if (deleted.length === 0) {
    return { error: "Budget not found", code: "budget_not_found" };
  }
  return { success: true, id };
}

export async function notifyOverBudgets(
  userId: string,
  now: Date = new Date(),
  send: (message: EmailMessage) => Promise<void> = sendEmail,
): Promise<number> {
  const overBudget = (await getBudgetStatuses(userId, now)).filter(
    (budget) => budget.overBudget,
  );
  if (overBudget.length === 0) return 0;

  const [user] = await db
    .select({
      email: schema.users.email,
      emailVerifiedAt: schema.users.email_verified_at,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user?.email || !user.emailVerifiedAt) return 0;

  const { month } = budgetMonth(now);
  let sent = 0;
  for (const budget of overBudget) {
    const alertKey = and(
      eq(schema.budget_alerts.user_id, userId),
      eq(schema.budget_alerts.category_id, budget.categoryId),
      eq(schema.budget_alerts.month, month),
    );
    let claimed: unknown[];
    try {
      claimed = await db
        .insert(schema.budget_alerts)
        .values({ user_id: userId, category_id: budget.categoryId, month })
        .onConflictDoNothing()
        .returning({ month: schema.budget_alerts.month });
    } catch (error) {
      getLogger().warn(
        { err: error, budgetId: budget.id },
        "could not claim over-budget alert",
      );
      continue;
    }
    if (claimed.length === 0) continue;

    try {
      await send({
        to: user.email,
        subject: m.email_budget_exceeded_subject({
          category: budget.categoryName,
        }),
        text: m.email_budget_exceeded_body({
          category: budget.categoryName,
          limit: formatMinor(budget.limitMinor),
          spent: formatMinor(budget.spentMinor),
          over: formatMinor(-budget.remainingMinor),
        }),
      });
      sent++;
    } catch (error) {
      await db.delete(schema.budget_alerts).where(alertKey);
      getLogger().error(
        { err: error, budgetId: budget.id },
        "failed to send over-budget alert",
      );
    }
  }
  return sent;
}

export function queueBudgetAlerts(userId: string): void {
  void notifyOverBudgets(userId).catch((error) =>
    getLogger().error({ err: error }, "over-budget alert evaluation failed"),
  );
}
