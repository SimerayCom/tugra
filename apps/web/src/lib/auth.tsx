"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, tokens } from "./api";
import type { PublicUser } from "./types";

interface AuthCtx {
  user: PublicUser | null;
  loading: boolean;
  reload: () => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  loading: true,
  reload: async () => {},
  logout: async () => {},
});

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<PublicUser | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = async () => {
    if (!tokens.access()) {
      setUser(null);
      setLoading(false);
      return;
    }
    try {
      setUser(await api.me());
    } catch {
      setUser(null);
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
    <Ctx.Provider value={{ user, loading, reload, logout }}>
      {children}
    </Ctx.Provider>
  );
}

export const useAuth = () => useContext(Ctx);
