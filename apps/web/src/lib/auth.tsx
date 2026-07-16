"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api } from "./api";
import type { PublicUser } from "./types";

interface AuthCtx {
  user: PublicUser | null;
  loading: boolean;
  /** Whether the instance finished first-user setup. `null` until known; `false` → fresh install (show
   *  the welcome/onboarding flow instead of login). Only resolved on the logged-out path. */
  initialized: boolean | null;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  loading: true,
  initialized: null,
  reload: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [initialized, setInitialized] = useState<boolean | null>(null);

  const reload = async () => {
    // The session lives in httpOnly cookies (invisible to JS), so ask the hub who we are: a valid
    // cookie returns the user, otherwise api.me() 401s (after a cookie-refresh attempt) → logged out.
    try {
      setUser(await api.me());
      setInitialized(true); // a live session implies the instance is already set up
    } catch {
      setUser(null);
      // Logged out: learn whether this is a fresh install that needs onboarding. Fail-safe to `true`
      // (→ login) so a transient status error never traps a returning user in the welcome flow.
      try {
        setInitialized((await api.getInstanceStatus()).initialized);
      } catch {
        setInitialized(true);
      }
    }
    setLoading(false);
  };

  useEffect(() => {
    void reload();
  }, []);

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  return (
    <Ctx.Provider value={{ user, loading, initialized, reload, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
