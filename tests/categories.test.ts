// @vitest-environment node

import { afterEach, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db, schema } from "#/db";
import {
  categorySubtree,
  childrenByParent,
  deleteCategoryForUser,
} from "#/server/categories.server";
import { hardDeleteUser } from "#/server/compliance.server";

const createdUsers: string[] = [];

afterEach(async () => {
  for (const userId of createdUsers.splice(0).reverse()) {
    await hardDeleteUser(userId);
  }
});

async function seedUser() {
  const userId = `cat-user-${crypto.randomUUID().slice(0, 8)}`;
  createdUsers.push(userId);
  await db.insert(schema.users).values({ id: userId, username: userId, password_hash: "x" });
  await db.insert(schema.accounts).values({ id: `${userId}-acc`, user_id: userId, name: "Main" });
  return userId;
}

async function seedCategory(userId: string, name: string, parentId: string | null = null) {
  const id = `${userId}-${name}`;
  await db.insert(schema.categories).values({ id, user_id: userId, name, parent_id: parentId });
  return id;
}

async function seedTransaction(userId: string, categoryId: string) {
  const id = crypto.randomUUID();
  await db.insert(schema.transactions).values({
    id,
    user_id: userId,
    account_id: `${userId}-acc`,
    amount_minor: -1_00,
    date: "2026-03-05",
    category_id: categoryId,
  });
  return id;
}

async function categoryIds(userId: string) {
  const rows = await db
    .select({ id: schema.categories.id })
    .from(schema.categories)
    .where(eq(schema.categories.user_id, userId));
  return rows.map((r) => r.id).sort();
}

async function transactionCategory(id: string) {
  const [row] = await db
    .select({ categoryId: schema.transactions.category_id })
    .from(schema.transactions)
    .where(eq(schema.transactions.id, id));
  return row.categoryId;
}

describe("category tree helpers", () => {
  const tree = childrenByParent([
    { id: "food", parentId: null },
    { id: "groceries", parentId: "food" },
    { id: "veg", parentId: "groceries" },
    { id: "dining", parentId: "food" },
    { id: "fun", parentId: null },
  ]);

  it.each([
    ["food", ["dining", "food", "groceries", "veg"]],
    ["groceries", ["groceries", "veg"]],
    ["veg", ["veg"]],
    ["unknown", ["unknown"]],
  ])("collects %s and every descendant", (root, expected) => {
    expect([...categorySubtree(root, tree)].sort()).toEqual(expected);
  });

  it("terminates on cycles", () => {
    const cyclic = childrenByParent([
      { id: "a", parentId: "b" },
      { id: "b", parentId: "a" },
    ]);
    expect([...categorySubtree("a", cyclic)].sort()).toEqual(["a", "b"]);
  });
});

describe("deleteCategoryForUser", () => {
  it("deletes the category with its descendants, budgets and alert history, and uncategorizes transactions", async () => {
    const userId = await seedUser();
    const food = await seedCategory(userId, "Food");
    const groceries = await seedCategory(userId, "Groceries", food);
    const keep = await seedCategory(userId, "Keep");
    const txn = await seedTransaction(userId, groceries);
    await db.insert(schema.budgets).values({
      id: `${userId}-b`,
      user_id: userId,
      category_id: groceries,
      limit_minor: 1_00,
    });
    await db.insert(schema.budget_alerts).values({ user_id: userId, category_id: groceries, month: "2026-03" });

    expect(await deleteCategoryForUser(userId, { id: food })).toEqual({ success: true });

    expect(await categoryIds(userId)).toEqual([keep]);
    expect(await transactionCategory(txn)).toBeNull();
    expect(await db.select().from(schema.budgets).where(eq(schema.budgets.user_id, userId))).toEqual([]);
    expect(await db.select().from(schema.budget_alerts).where(eq(schema.budget_alerts.user_id, userId))).toEqual([]);
  });

  it("reassigns transactions to the chosen category", async () => {
    const userId = await seedUser();
    const source = await seedCategory(userId, "Source");
    const target = await seedCategory(userId, "Target");
    const txn = await seedTransaction(userId, source);

    expect(await deleteCategoryForUser(userId, { id: source, reassignToCategoryId: target })).toEqual({
      success: true,
    });
    expect(await transactionCategory(txn)).toBe(target);
  });

  it("cannot delete another user's category", async () => {
    const owner = await seedUser();
    const attacker = await seedUser();
    const victim = await seedCategory(owner, "Private");

    expect(await deleteCategoryForUser(attacker, { id: victim })).toEqual({ error: "Category not found" });
    expect(await categoryIds(owner)).toEqual([victim]);
  });

  it("cannot reassign transactions into another user's category", async () => {
    const userId = await seedUser();
    const other = await seedUser();
    const source = await seedCategory(userId, "Source");
    const foreign = await seedCategory(other, "Foreign");
    const txn = await seedTransaction(userId, source);

    expect(await deleteCategoryForUser(userId, { id: source, reassignToCategoryId: foreign })).toEqual({
      error: "Reassignment target category does not exist",
    });
    expect(await categoryIds(userId)).toEqual([source]);
    expect(await transactionCategory(txn)).toBe(source);
  });

  it.each([
    ["itself", (_parent: string, _child: string) => _parent],
    ["one of its own descendants", (_parent: string, child: string) => child],
  ])("refuses to reassign into %s and changes nothing", async (_label, pickTarget) => {
    const userId = await seedUser();
    const parent = await seedCategory(userId, "Parent");
    const child = await seedCategory(userId, "Child", parent);
    const txn = await seedTransaction(userId, parent);

    expect(
      await deleteCategoryForUser(userId, { id: parent, reassignToCategoryId: pickTarget(parent, child) }),
    ).toEqual({ error: "Cannot reassign transactions to the category being deleted" });
    expect(await categoryIds(userId)).toEqual([child, parent].sort());
    expect(await transactionCategory(txn)).toBe(parent);
  });

  it("rolls back every step when a later delete fails", async () => {
    const userId = await seedUser();
    const other = await seedUser();
    const doomed = await seedCategory(userId, "Doomed");
    const txn = await seedTransaction(userId, doomed);
    const foreignTxn = crypto.randomUUID();
    await db.insert(schema.transactions).values({
      id: foreignTxn,
      user_id: other,
      account_id: `${other}-acc`,
      amount_minor: -1_00,
      date: "2026-03-05",
      category_id: doomed,
    });

    await expect(deleteCategoryForUser(userId, { id: doomed })).rejects.toThrow();

    expect(await categoryIds(userId)).toEqual([doomed]);
    expect(await transactionCategory(txn)).toBe(doomed);
    await db.delete(schema.transactions).where(inArray(schema.transactions.id, [foreignTxn]));
  });
});
