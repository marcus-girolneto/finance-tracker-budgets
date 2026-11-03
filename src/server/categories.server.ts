import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "#/db";

export type DeleteCategoryResult = { success: true } | { error: string };

export function childrenByParent(
  categories: ReadonlyArray<{ id: string; parentId: string | null }>,
): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const category of categories) {
    if (!category.parentId) continue;
    const siblings = children.get(category.parentId);
    if (siblings) siblings.push(category.id);
    else children.set(category.parentId, [category.id]);
  }
  return children;
}

export function categorySubtree(
  rootId: string,
  children: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const visited = new Set<string>([rootId]);
  const pending = [rootId];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    for (const child of children.get(current) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      pending.push(child);
    }
  }
  return visited;
}

export async function deleteCategoryForUser(
  userId: string,
  data: { id: string; reassignToCategoryId?: string | null },
): Promise<DeleteCategoryResult> {
  if (data.reassignToCategoryId === data.id) {
    return {
      error: "Cannot reassign transactions to the category being deleted",
    };
  }

  return db.transaction(async (tx): Promise<DeleteCategoryResult> => {
    await tx
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .for("update");

    const ownedCategories = await tx
      .select({ id: schema.categories.id, parent_id: schema.categories.parent_id })
      .from(schema.categories)
      .where(eq(schema.categories.user_id, userId));
    if (!ownedCategories.some((c) => c.id === data.id)) {
      return { error: "Category not found" };
    }
    if (
      data.reassignToCategoryId &&
      !ownedCategories.some((c) => c.id === data.reassignToCategoryId)
    ) {
      return { error: "Reassignment target category does not exist" };
    }

    const idsToDelete = categorySubtree(
      data.id,
      childrenByParent(
        ownedCategories.map((c) => ({ id: c.id, parentId: c.parent_id })),
      ),
    );
    if (data.reassignToCategoryId && idsToDelete.has(data.reassignToCategoryId)) {
      return {
        error: "Cannot reassign transactions to the category being deleted",
      };
    }
    const allIdsToDelete = [...idsToDelete];

    // Reassign transactions to the target, or reset their category
    await tx
      .update(schema.transactions)
      .set({ category_id: data.reassignToCategoryId || null })
      .where(
        and(
          inArray(schema.transactions.category_id, allIdsToDelete),
          eq(schema.transactions.user_id, userId),
        ),
      );

    // Reset category_id on receipt_items that reference any of these categories
    await tx
      .update(schema.receipt_items)
      .set({ category_id: null })
      .where(inArray(schema.receipt_items.category_id, allIdsToDelete));

    // Delete categorization_rules that reference any of these categories
    await tx
      .delete(schema.categorization_rules)
      .where(inArray(schema.categorization_rules.category_id, allIdsToDelete));

    await tx
      .delete(schema.budgets)
      .where(
        and(
          inArray(schema.budgets.category_id, allIdsToDelete),
          eq(schema.budgets.user_id, userId),
        ),
      );
    await tx
      .delete(schema.budget_alerts)
      .where(
        and(
          inArray(schema.budget_alerts.category_id, allIdsToDelete),
          eq(schema.budget_alerts.user_id, userId),
        ),
      );

    await tx
      .delete(schema.categories)
      .where(
        and(
          inArray(schema.categories.id, allIdsToDelete),
          eq(schema.categories.user_id, userId),
        ),
      );

    return { success: true };
  });
}
