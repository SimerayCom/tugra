"use client";

import { useEffect } from "react";
import { api } from "../lib/api";
import { currentSubscription, describeDevice, pushSupport, storeDeviceId, storedDeviceId, subscriptionBody } from "../lib/pwa";

const GUARD = "tugra.pushResynced";

/**
 * Keeps this browser's push registration true after sign-in: a browser can rotate its subscription endpoint, and the hub
 * drops a subscription its push service reports gone. Once per tab session, if the user turned push on here, re-send
 * the current subscription (an idempotent upsert by endpoint); if the browser no longer has one, forget the device.
 */
export function usePushResync(signedIn: boolean): void {
  useEffect(() => {
    if (!signedIn || storedDeviceId() === null) return;
    if (pushSupport() !== "ok" || typeof Notification === "undefined" || Notification.permission !== "granted") return;
    try {
      if (sessionStorage.getItem(GUARD)) return;
      sessionStorage.setItem(GUARD, "1");
    } catch {
      /* no sessionStorage: just run */
    }
    void (async () => {
      try {
        const sub = await currentSubscription();
        if (!sub) {
          storeDeviceId(null);
          return;
        }
        const d = await api.addPushDevice(subscriptionBody(sub, describeDevice(navigator.userAgent) || undefined));
        storeDeviceId(d.id);
      } catch {
        /* best effort: Settings shows the truth and lets the user redo it */
      }
    })();
  }, [signedIn]);
}
