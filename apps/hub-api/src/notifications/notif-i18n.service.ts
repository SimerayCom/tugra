import { Injectable } from "@nestjs/common";
import en from "./locales/en.json";
import type { NotifI18n } from "./event";

type Catalog = Record<string, unknown>;

/** Walk a dotted key (e.g. "deploy.failed.title") into a nested catalog; undefined if missing/non-string. */
function lookup(dict: Catalog, key: string): string | undefined {
  const raw = key.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Catalog)[k] : undefined), dict);
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Server-side notification i18n. Catalogs are statically imported (no async load). `forLocale` returns a
 * `t(key, params)` bound to a locale, falling back locale-catalog → en → the raw key (so a gap is visible,
 * never a crash). Interpolation is single-brace `{param}` (same convention as the web `translate.ts`).
 * Adding a language is a JSON drop + one entry in `catalogs` — no migration (locale is a free string).
 */
@Injectable()
export class NotifI18nService {
  private readonly catalogs: Record<string, Catalog> = { en };

  forLocale(locale?: string): NotifI18n {
    const dict = this.catalogs[locale ?? "en"];
    const fallback = this.catalogs.en;
    return (key: string, params?: Record<string, string | number>): string => {
      const raw = (dict && lookup(dict, key)) ?? lookup(fallback, key) ?? key;
      if (!params) return raw;
      // Function replacer, NOT a string: a string replacement would honor $-patterns ($$, $&, $1…) in a
      // user-controlled param value (e.g. a resource named "db$&prod"); a function returns it verbatim.
      return Object.entries(params).reduce((s, [k, v]) => s.replaceAll(`{${k}}`, () => String(v)), raw);
    };
  }
}
