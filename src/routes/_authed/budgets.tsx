import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { m } from "#/paraglide/messages";
import { formatMinor, minorToInputValue, parseAmountToMinor } from "#/lib/money";
import { cn } from "#/lib/utils";
import { EditButton, DeleteButton } from "#/components/ui/action-buttons";
import { Button } from "#/components/ui/button";
import { CategoryBadge } from "#/components/ui/category-badge";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Select, SelectItem } from "#/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog";
import {
  MAX_BUDGET_LIMIT_MINOR,
  createBudget,
  deleteBudget,
  getBudgets,
  updateBudget,
  type BudgetMutationResult,
  type BudgetStatus,
} from "#/server/budgets.functions";
import { getCategories } from "#/server/categories.functions";

const BUDGETS_QUERY_KEY = ["budgets"] as const;
const CATEGORIES_QUERY_KEY = ["categories"] as const;
const BILLING_QUERY_KEY = ["billing"] as const;

type MutationResult = BudgetMutationResult;

interface CategoryOption {
  id: string;
  label: string;
}

function errorMessage(result: Exclude<MutationResult, { success: true }>): string {
  switch (result.code) {
    case "budget_limit_reached":
      return m.budgets_limit_reached({ limit: result.limit ?? 0 });
    case "budget_exists":
      return m.budgets_exists();
    case "category_not_found":
      return m.budgets_category_missing();
    case "budget_not_found":
      return m.budgets_not_found();
  }
}

function BudgetForm({
  isOpen,
  editing,
  categoryOptions,
  error,
  submitting,
  onClose,
  onSubmit,
}: {
  isOpen: boolean;
  editing: BudgetStatus | null;
  categoryOptions: CategoryOption[];
  error: string | null;
  submitting: boolean;
  onClose: () => void;
  onSubmit: (data: { categoryId: string; limitMinor: number }) => void;
}) {
  const [categoryId, setCategoryId] = useState("");
  const [limit, setLimit] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setCategoryId(editing?.categoryId ?? "");
    setLimit(editing ? String(minorToInputValue(editing.limitMinor)) : "");
    setValidationError(null);
  }, [isOpen, editing]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing && !categoryId) {
      setValidationError(m.budgets_category_required());
      return;
    }
    const limitMinor = parseAmountToMinor(limit);
    if (limitMinor === null || limitMinor <= 0 || limitMinor > MAX_BUDGET_LIMIT_MINOR) {
      setValidationError(m.budgets_limit_invalid());
      return;
    }
    setValidationError(null);
    onSubmit({ categoryId, limitMinor });
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {editing ? m.budgets_edit_title() : m.budgets_add()}
          </DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4" noValidate>
          <div>
            <Label htmlFor="budget-category" className="mb-1">
              {m.budgets_category_label()}
            </Label>
            {editing ? (
              <CategoryBadge
                name={editing.categoryName}
                color={editing.categoryColor}
              />
            ) : (
              <Select
                id="budget-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                <SelectItem value="">{m.budgets_category_placeholder()}</SelectItem>
                {categoryOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.label}
                  </SelectItem>
                ))}
              </Select>
            )}
          </div>

          <div>
            <Label htmlFor="budget-limit" className="mb-1">
              {m.budgets_limit_label()}
            </Label>
            <Input
              id="budget-limit"
              type="number"
              inputMode="decimal"
              min="0.01"
              step="0.01"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              className="w-40"
              autoFocus={!!editing}
            />
          </div>

          {(validationError ?? error) && (
            <div className="text-destructive text-sm" role="alert">
              {validationError ?? error}
            </div>
          )}

          <DialogFooter className="pt-2">
            <Button
              type="button"
              variant="outline"
              onClick={onClose}
              disabled={submitting}
            >
              {m.cancel()}
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting
                ? editing
                  ? m.saving()
                  : m.creating()
                : editing
                  ? m.save_changes()
                  : m.budgets_create()}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function BudgetCard({
  budget,
  onEdit,
  onDelete,
}: {
  budget: BudgetStatus;
  onEdit: (budget: BudgetStatus) => void;
  onDelete: (budget: BudgetStatus) => void;
}) {
  const percent = Math.min(100, (budget.spentMinor / budget.limitMinor) * 100);

  return (
    <li
      data-testid="budget-row"
      className={cn(
        "rounded-lg border bg-card p-4 space-y-3",
        budget.overBudget ? "border-destructive/60" : "border-line",
      )}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <CategoryBadge name={budget.categoryName} color={budget.categoryColor} />
          {budget.overBudget && (
            <span
              data-testid="budget-over"
              className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive"
            >
              {m.budgets_over_badge()}
            </span>
          )}
        </div>
        <div className="flex gap-1">
          <EditButton onClick={() => onEdit(budget)} data-testid="edit-budget" />
          <DeleteButton onClick={() => onDelete(budget)} data-testid="delete-budget" />
        </div>
      </div>

      <div
        role="progressbar"
        aria-label={budget.categoryName}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(percent)}
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
      >
        <div
          className={cn(
            "h-full rounded-full",
            budget.overBudget ? "bg-destructive" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>

      <dl className="grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">{m.budgets_limit()}</dt>
          <dd data-testid="budget-limit" className="font-medium tabular-nums">
            {formatMinor(budget.limitMinor)} {m.analytics_currency()}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{m.budgets_spent()}</dt>
          <dd data-testid="budget-spent" className="font-medium tabular-nums">
            {formatMinor(budget.spentMinor)} {m.analytics_currency()}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">{m.budgets_left()}</dt>
          <dd
            data-testid="budget-left"
            className={cn(
              "font-medium tabular-nums",
              budget.overBudget && "text-destructive",
            )}
          >
            {budget.overBudget
              ? m.budgets_over_by({
                  amount: `${formatMinor(-budget.remainingMinor)} ${m.analytics_currency()}`,
                })
              : `${formatMinor(budget.remainingMinor)} ${m.analytics_currency()}`}
          </dd>
        </div>
      </dl>
    </li>
  );
}

export const Route = createFileRoute("/_authed/budgets")({
  component: BudgetsPage,
});

function BudgetsPage() {
  const queryClient = useQueryClient();
  const getBudgetsFn = useServerFn(getBudgets);
  const getCategoriesFn = useServerFn(getCategories);
  const createBudgetFn = useServerFn(createBudget);
  const updateBudgetFn = useServerFn(updateBudget);
  const deleteBudgetFn = useServerFn(deleteBudget);

  const { data: overview, isLoading } = useQuery({
    queryKey: BUDGETS_QUERY_KEY,
    queryFn: () => getBudgetsFn(),
  });
  const { data: categories = [] } = useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: () => getCategoriesFn(),
  });

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editing, setEditing] = useState<BudgetStatus | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<BudgetStatus | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: BUDGETS_QUERY_KEY }),
      queryClient.invalidateQueries({ queryKey: BILLING_QUERY_KEY }),
    ]);

  const saveMutation = useMutation({
    mutationFn: (data: { categoryId: string; limitMinor: number }): Promise<MutationResult> =>
      editing
        ? updateBudgetFn({ data: { id: editing.id, limitMinor: data.limitMinor } })
        : createBudgetFn({ data }),
    onSuccess: (result) => {
      if ("error" in result) {
        setFormError(errorMessage(result));
        return;
      }
      setIsFormOpen(false);
      setEditing(null);
      void invalidate();
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string): Promise<MutationResult> => deleteBudgetFn({ data: { id } }),
    onSuccess: (result) => {
      if ("error" in result) {
        setDeleteError(errorMessage(result));
        return;
      }
      setDeleting(null);
      void invalidate();
    },
  });

  const budgets = overview?.budgets ?? [];
  const maxBudgets = overview?.maxBudgets ?? null;
  const atLimit = maxBudgets !== null && budgets.length >= maxBudgets;

  const categoryOptions = useMemo(() => {
    const budgeted = new Set(budgets.map((b) => b.categoryId));
    const nameById = new Map(categories.map((c) => [c.id, c.name]));
    return categories
      .filter((c) => !budgeted.has(c.id))
      .map((c) => {
        const parentName = c.parent_id ? nameById.get(c.parent_id) : undefined;
        return { id: c.id, label: parentName ? `${parentName} › ${c.name}` : c.name };
      })
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [budgets, categories]);

  const openCreate = () => {
    setEditing(null);
    setFormError(null);
    setIsFormOpen(true);
  };

  const openEdit = (budget: BudgetStatus) => {
    setEditing(budget);
    setFormError(null);
    setIsFormOpen(true);
  };

  return (
    <div className="min-h-screen">
      <header className="border-b border-line/50 bg-header-bg/80 backdrop-blur-sm">
        <div className="page-wrap py-4 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold display-title">{m.budgets_title()}</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              {m.budgets_subtitle({ month: overview?.month ?? "" })}
            </p>
          </div>
          <Button onClick={openCreate}>{m.budgets_add()}</Button>
        </div>
      </header>

      <main className="page-wrap py-6 space-y-4 max-w-3xl">
        {overview && (
          <p className="text-sm text-muted-foreground" data-testid="budgets-usage">
            {maxBudgets === null
              ? m.budgets_usage_unlimited({ used: budgets.length })
              : m.budgets_usage_limited({ used: budgets.length, limit: maxBudgets })}
            {atLimit && (
              <>
                {" · "}
                <Link to="/billing" className="text-primary underline">
                  {m.budgets_upgrade_link()}
                </Link>
              </>
            )}
          </p>
        )}

        {isLoading ? (
          <p className="text-sm text-muted-foreground">{m.budgets_loading()}</p>
        ) : budgets.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <h3 className="text-base font-medium mb-1">{m.budgets_empty_title()}</h3>
            <p className="text-sm text-muted-foreground max-w-sm">
              {categories.length === 0 ? m.budgets_no_categories() : m.budgets_empty_desc()}
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {budgets.map((budget) => (
              <BudgetCard
                key={budget.id}
                budget={budget}
                onEdit={openEdit}
                onDelete={(b) => {
                  setDeleteError(null);
                  setDeleting(b);
                }}
              />
            ))}
          </ul>
        )}
      </main>

      <BudgetForm
        isOpen={isFormOpen}
        editing={editing}
        categoryOptions={categoryOptions}
        error={formError}
        submitting={saveMutation.isPending}
        onClose={() => {
          setIsFormOpen(false);
          setEditing(null);
          setFormError(null);
        }}
        onSubmit={(data) => {
          setFormError(null);
          saveMutation.mutate(data);
        }}
      />

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => !open && setDeleting(null)}
      >
        <AlertDialogContent className="sm:max-w-sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{m.budgets_delete_title()}</AlertDialogTitle>
            <AlertDialogDescription>
              {m.budgets_delete_desc({ category: deleting?.categoryName ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <div className="text-destructive text-sm" role="alert">
              {deleteError}
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>{m.cancel()}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault();
                if (deleting) deleteMutation.mutate(deleting.id);
              }}
            >
              {m.delete()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
