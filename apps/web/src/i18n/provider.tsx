"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import en from "./locales/en";
import { translate, type Messages } from "./translate";

// Add new locales here later (translate the JSON files). English is primary.
const LOCALES: Record<string, Messages> = { en };
export const DEFAULT_LOCALE = "en";

type TFn = (key: string, vars?: Record<string, string | number>) => string;

const Ctx = createContext<{ lang: string; t: TFn; setLang: (l: string) => void }>({
  lang: DEFAULT_LOCALE,
  t: (k) => k,
  setLang: () => {},
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState(DEFAULT_LOCALE);
  useEffect(() => {
    const saved = localStorage.getItem("tugra.lang");
    if (saved && LOCALES[saved]) setLang(saved);
  }, []);

  const dict = LOCALES[lang] ?? en;
  const t: TFn = (key, vars) => translate(dict, key, vars);
  const change = (l: string) => {
    setLang(l);
    localStorage.setItem("tugra.lang", l);
  };

  return (
    <Ctx.Provider value={{ lang, t, setLang: change }}>{children}</Ctx.Provider>
  );
}

export const useT = (): TFn => useContext(Ctx).t;
export const useI18n = () => useContext(Ctx);
