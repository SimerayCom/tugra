"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Smartphone, Trash2 } from "lucide-react";
import { api } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../i18n/provider";
import { Badge, Btn, Card } from "../../../components/ui";
import { IconBtn } from "../../../components/icon-btn";
import { useToast } from "../../../components/toast";
import {
  currentSubscription,
  describeDevice,
  isIos,
  pushSupport,
  storeDeviceId,
  storedDeviceId,
  subscribeThisBrowser,
  subscriptionBody,
  useInstallPrompt,
} from "../../../lib/pwa";

const hint: React.CSSProperties = { fontSize: 12, color: "var(--c-tx3)", margin: "6px 0 14px", lineHeight: 1.5 };

/** Install the panel as an app. Chromium offers a real prompt; iOS has no prompt, so it gets the two-tap instruction. */
export function InstallAppCard() {
  const t = useT();
  const { canInstall, installed, install } = useInstallPrompt();
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600 }}>{t("pwa.installTitle")}</div>
        {installed && <Badge tone="gold">{t("pwa.installed")}</Badge>}
      </div>
      <p style={hint}>{t("pwa.installDesc")}</p>
      {installed ? null : canInstall ? (
        <Btn icon={Smartphone} onClick={() => void install()}>{t("pwa.installBtn")}</Btn>
      ) : (
        <p role="note" style={{ ...hint, margin: 0 }}>{isIos() ? t("pwa.installIos") : t("pwa.installUnavailable")}</p>
      )}
    </Card>
  );
}

/** This user's push devices: turn it on for this browser, see/remove devices, send a test. */
export function PushDevicesCard() {
  const t = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const { user } = useAuth();
  const showChannelLink = user?.uiMode !== "home"; // channels are a fleet-mode page
  const [support, setSupport] = useState<ReturnType<typeof pushSupport>>("ok");
  const [permission, setPermission] = useState<NotificationPermission>("default");
  const [thisId, setThisId] = useState<string | null>(null);
  useEffect(() => {
    setSupport(pushSupport());
    if (typeof Notification !== "undefined") setPermission(Notification.permission);
    setThisId(storedDeviceId());
  }, []);

  const { data: devices = [] } = useQuery({ queryKey: ["pushDevices"], queryFn: () => api.listPushDevices() });
  const refresh = () => qc.invalidateQueries({ queryKey: ["pushDevices"] });
  const onThisDevice = thisId !== null && devices.some((d) => d.id === thisId);

  const enable = useMutation({
    mutationFn: async () => {
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== "granted") return null;
      const { publicKey } = await api.pushPublicKey();
      const sub = await subscribeThisBrowser(publicKey);
      return api.addPushDevice(subscriptionBody(sub, describeDevice(navigator.userAgent) || undefined));
    },
    onSuccess: (d) => {
      if (!d) return;
      storeDeviceId(d.id);
      setThisId(d.id);
      void refresh();
    },
    onError: (e) => toast(e instanceof Error && e.message ? e.message : t("pwa.pushFailed"), "error"),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => {
      await api.removePushDevice(id);
      if (id === thisId) {
        const sub = await currentSubscription();
        await sub?.unsubscribe();
        storeDeviceId(null);
        setThisId(null);
      }
    },
    onSuccess: () => void refresh(),
  });

  const test = useMutation({
    mutationFn: () => api.testPush({ title: t("pwa.testTitle"), body: t("pwa.testBody") }),
    onSuccess: () => toast(t("pwa.pushTestSent"), "success"),
  });

  const blocked = permission === "denied";
  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ fontWeight: 600 }}>{t("pwa.pushTitle")}</div>
        {onThisDevice && <Badge tone="gold">{t("pwa.pushOn")}</Badge>}
      </div>
      <p style={hint}>{t("pwa.pushDesc")}</p>

      {support !== "ok" ? (
        <p role="note" style={{ ...hint, margin: 0 }}>
          {support === "insecure" ? t("pwa.pushNeedsHttps") : support === "ios-needs-install" ? t("pwa.pushIosHint") : t("pwa.pushUnsupported")}
        </p>
      ) : blocked ? (
        <p role="alert" style={{ ...hint, margin: 0, color: "var(--c-am)" }}>{t("pwa.pushBlocked")}</p>
      ) : onThisDevice ? (
        <Btn variant="ghost" loading={remove.isPending} onClick={() => thisId && remove.mutate(thisId)}>{t("pwa.pushDisable")}</Btn>
      ) : (
        <Btn loading={enable.isPending} onClick={() => enable.mutate()}>{t("pwa.pushEnable")}</Btn>
      )}

      <div style={{ marginTop: 18 }}>
        <div id="push-devices-label" style={{ fontSize: 11, fontWeight: 700, color: "var(--c-tx3)", textTransform: "uppercase", letterSpacing: "0.05em", marginBottom: 6 }}>
          {t("pwa.devices")}
        </div>
        {devices.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--c-tx3)" }}>{t("pwa.devicesNone")}</div>
        ) : (
          <ul aria-labelledby="push-devices-label" style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
            {devices.map((d) => {
              const name = d.deviceLabel || t("pwa.deviceUnnamed");
              return (
                <li key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, minHeight: 44 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {name} {d.id === thisId && <Badge tone="gold">{t("pwa.deviceThis")}</Badge>}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--c-tx3)" }}>{t("pwa.deviceAdded", { date: new Date(d.createdAt).toLocaleDateString() })}</div>
                  </div>
                  <IconBtn label={t("pwa.deviceRemove", { name })} danger onClick={() => remove.mutate(d.id)}><Trash2 size={15} /></IconBtn>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap", alignItems: "center" }}>
        {devices.length > 0 && <Btn variant="ghost" loading={test.isPending} onClick={() => test.mutate()}>{t("pwa.pushTest")}</Btn>}
        {showChannelLink && <Link href="/notifications" className="tg-link" style={{ fontSize: 13 }}>{t("pwa.channelLink")}</Link>}
      </div>
      {showChannelLink && <p style={{ ...hint, margin: "10px 0 0" }}>{t("pwa.channelHint")}</p>}
    </Card>
  );
}
