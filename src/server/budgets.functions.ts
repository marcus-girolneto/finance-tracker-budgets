import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { getEntitlements } from "#/server/billing.server";
import {
  budgetMonth,
  createBudget as createBudgetInternal,
  deleteBudget as deleteBudgetInternal,
  getBudgetStatuses,
  queueBudgetAlerts,
  updateBudgetLimit,
  type BudgetMutationResult,
  type BudgetStatus,
} from "#/server/budgets.server";
import { requireUserId } from "#/server/session";

export type {
  BudgetErrorCode,
  BudgetMutationResult,
  BudgetStatus,
} from "#/server/budgets.server";

export const MAX_BUDGET_LIMIT_MINOR = 2_147_483_647;

const limitMinorSchema = z
  .number()
  .int()
  .positive("Limit must be greater than zero")
  .max(MAX_BUDGET_LIMIT_MINOR);

const createBudgetSchema = z.object({
  categoryId: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const updateBudgetSchema = z.object({
  id: z.string().min(1),
  limitMinor: limitMinorSchema,
});

const deleteBudgetSchema = z.object({
  id: z.string().min(1),
});

export interface BudgetsOverview {
  month: string;
  maxBudgets: number | null;
  budgets: BudgetStatus[];
}

export const getBudgets = createServerFn({ method: "GET" }).handler(
  async (): Promise<BudgetsOverview> => {
    const userId = await requireUserId();
    const now = new Date();
    const [budgets, entitlements] = await Promise.all([
      getBudgetStatuses(userId, now),
      getEntitlements(userId),
    ]);
    return {
      month: budgetMonth(now).month,
      maxBudgets: entitlements.maxBudgets,
      budgets,
    };
  },
);

export const createBudget = createServerFn({ method: "POST" })
  .inputValidator(createBudgetSchema)
  .handler(async ({ data }): Promise<BudgetMutationResult> => {
    const userId = await requireUserId();
    const result = await createBudgetInternal(userId, data);
    if ("success" in result) queueBudgetAlerts(userId);
    return result;
  });

export const updateBudget = createServerFn({ method: "POST" })
  .inputValidator(updateBudgetSchema)
  .handler(async ({ data }): Promise<BudgetMutationResult> => {
    const userId = await requireUserId();
    const result = await updateBudgetLimit(userId, data);
    if ("success" in result) queueBudgetAlerts(userId);
    return result;
  });

export const deleteBudget = createServerFn({ method: "POST" })
  .inputValidator(deleteBudgetSchema)
  .handler(async ({ data }): Promise<BudgetMutationResult> => {
    const userId = await requireUserId();
    return deleteBudgetInternal(userId, data.id);
  });
