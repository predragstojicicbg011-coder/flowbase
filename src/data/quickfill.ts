// ─── Quick-fill script: the shape of a classification template ──────────────
//
// The templates themselves live in `public.quick_fill_scripts` and are set up
// by the user (see src/services/quickFillStore.ts). A script is a reusable
// CLASSIFICATION — category, department, cost type. It carries no project:
// a project is chosen per document, and a template that silently assigned one
// would put next month's bills on last month's site.

export interface QuickFillScript {
  id: string
  name: string          // Display name in dropdown
  icon: string          // Emoji icon
  pl_category: string
  pl_subcategory: string
  department: string
  dept_subcategory: string
  expense_description: string
  cf_type: string       // recurring | one_time | accrual | capex | reimbursable | ""
  sort_order?: number
}
