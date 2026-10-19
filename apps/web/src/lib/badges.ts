/**
 * Human label for a capability badge slug (e.g. "db" → "Database"). Badges are free-form strings the curated
 * catalog overlay can add, so an unknown slug has no i18n key — fall back to the slug itself rather than render
 * the raw key ("resources.badge_gpu"). Keep the `badge_<slug>` keys in the resources locale in sync as slugs grow.
 */
export function badgeLabel(t: (key: string) => string, slug: string): string {
  const key = `resources.badge_${slug}`;
  const label = t(key);
  return label === key ? slug : label;
}
