import type { Template } from "./types";

// app-store category display order (also drives the filter-chip order)
export const CATEGORY_ORDER = [
  "cms",
  "productivity",
  "developer",
  "analytics",
  "automation",
  "ai",
  "monitoring",
  "communication",
  "media",
  "finance",
  "security",
  "database",
  "tools",
];

/** Filter the app-store templates by a free-text query and an active category. */
export function filterTemplates(templates: Template[], q: string, cat: string): Template[] {
  const needle = q.trim().toLowerCase();
  return templates.filter((tpl) => {
    if (cat !== "all" && tpl.category !== cat) return false;
    if (!needle) return true;
    return `${tpl.name} ${tpl.description} ${tpl.category}`.toLowerCase().includes(needle);
  });
}

/** Categories present in the catalog, in display order. */
export function presentCategories(templates: Template[]): string[] {
  const present = new Set(templates.map((t) => t.category));
  return CATEGORY_ORDER.filter((c) => present.has(c)).concat(
    [...present].filter((c) => !CATEGORY_ORDER.includes(c)).sort(),
  );
}

/**
 * Group templates by category, in display order. Only categories that have at
 * least one template appear (drives the app-store's "browse all" section list).
 */
export function groupByCategory(templates: Template[]): { category: string; items: Template[] }[] {
  return presentCategories(templates).map((category) => ({
    category,
    items: templates.filter((t) => t.category === category),
  }));
}
