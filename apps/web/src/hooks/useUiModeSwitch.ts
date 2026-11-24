"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../i18n/provider";
import { homeScale, modeSwitchBody, modeSwitchImpact } from "../lib/home-mode";
import { uiMode, type UiMode } from "../lib/ui-mode";
import { useRiskySetting } from "./useRiskySetting";

/**
 * Switch the interface mode (Fleet / Home). Moving to Home on an install with several servers or teams asks
 * first, spelling out what gets hidden; every switch offers a one-click Undo.
 */
export function useUiModeSwitch() {
  const t = useT();
  const { user, reload } = useAuth();
  const risky = useRiskySetting();
  const current = uiMode(user?.uiMode);
  const { data: servers = [] } = useQuery({ queryKey: ["servers"], queryFn: () => api.listServers() });
  const { data: teams = [] } = useQuery({ queryKey: ["teams"], queryFn: () => api.listTeams() });
  const { data: apps = [] } = useQuery({ queryKey: ["apps"], queryFn: () => api.listApps() });
  const [pending, setPending] = useState(false);

  const set = async (mode: UiMode) => {
    await api.updateProfile({ uiMode: mode });
    await reload();
  };

  const switchTo = async (to: UiMode): Promise<boolean> => {
    if (to === current || pending) return false;
    const scale = homeScale(servers, teams, apps);
    const impact = modeSwitchImpact(to, scale);
    setPending(true);
    try {
      return await risky({
        risky: impact.risky,
        confirm: { title: t("settings.uiModeConfirmTitle"), body: modeSwitchBody(t, scale), confirmLabel: t("settings.uiModeConfirmAction") },
        apply: () => set(to),
        undo: () => set(current),
        doneMessage: t("settings.uiModeSaved"),
        undoneMessage: t("settings.uiModeUndone", { mode: t(current === "home" ? "settings.uiModeHome" : "settings.uiModeFleet") }),
      });
    } finally {
      setPending(false);
    }
  };

  return { mode: current, switchTo, pending };
}
