import { describe, it, expect, afterEach, vi } from "vitest";
import { PUSH_DEVICE_KEY, describeDevice, pushSupport, releasePushDevice, storedDeviceId, sameBytes, subscriptionBody, urlBase64ToUint8Array } from "./pwa";

afterEach(() => vi.unstubAllGlobals());

describe("urlBase64ToUint8Array", () => {
  it("decodes base64url (no padding, - and _) to bytes", () => {
    // 65-byte VAPID-shaped key: 0x04 then 64 bytes
    const bytes = new Uint8Array([4, ...Array.from({ length: 64 }, (_, i) => (i * 7 + 250) % 256)]);
    const b64u = Buffer.from(bytes).toString("base64url");
    expect(Array.from(urlBase64ToUint8Array(b64u))).toEqual(Array.from(bytes));
    expect(b64u).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe("sameBytes", () => {
  it("compares an ArrayBuffer to bytes", () => {
    const a = new Uint8Array([1, 2, 3]);
    expect(sameBytes(a.buffer, new Uint8Array([1, 2, 3]))).toBe(true);
    expect(sameBytes(a.buffer, new Uint8Array([1, 2, 4]))).toBe(false);
    expect(sameBytes(a.buffer, new Uint8Array([1, 2]))).toBe(false);
    expect(sameBytes(null, a)).toBe(false);
  });
});

describe("describeDevice", () => {
  it("names browser and OS", () => {
    expect(describeDevice("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36")).toBe("Chrome on macOS");
    expect(describeDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1")).toBe("Safari on iOS");
    expect(describeDevice("Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0")).toBe("Firefox on Linux");
    expect(describeDevice("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36 Edg/120.0")).toBe("Edge on Windows");
    expect(describeDevice("")).toBe("");
  });
});

describe("pushSupport", () => {
  it("is insecure off HTTPS", () => {
    vi.stubGlobal("isSecureContext", false);
    expect(pushSupport()).toBe("insecure");
  });
  it("is ok when the three APIs exist", () => {
    vi.stubGlobal("isSecureContext", true);
    vi.stubGlobal("PushManager", class {});
    vi.stubGlobal("Notification", class {});
    Object.defineProperty(navigator, "serviceWorker", { value: {}, configurable: true });
    expect(pushSupport()).toBe("ok");
  });
  it("tells iPhone users to install first when push is missing", () => {
    vi.stubGlobal("isSecureContext", true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (window as any).PushManager;
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)");
    expect(pushSupport()).toBe("ios-needs-install");
    vi.restoreAllMocks();
  });
});

describe("subscriptionBody", () => {
  it("shapes the browser subscription for the hub", () => {
    const sub = { toJSON: () => ({ endpoint: "https://push.example.com/x", keys: { p256dh: "P", auth: "A" } }) } as unknown as PushSubscription;
    expect(subscriptionBody(sub, "Chrome on macOS")).toEqual({ endpoint: "https://push.example.com/x", keys: { p256dh: "P", auth: "A" }, deviceLabel: "Chrome on macOS" });
    expect(subscriptionBody(sub)).not.toHaveProperty("deviceLabel");
  });
});

describe("releasePushDevice", () => {
  it("deletes the device on the hub and forgets it locally", async () => {
    localStorage.setItem(PUSH_DEVICE_KEY, "dev1");
    const remove = vi.fn().mockResolvedValue({ ok: true });
    await releasePushDevice(remove);
    expect(remove).toHaveBeenCalledWith("dev1");
    expect(storedDeviceId()).toBeNull();
  });

  it("still forgets the device when the hub call fails, and does nothing without one", async () => {
    localStorage.setItem(PUSH_DEVICE_KEY, "dev2");
    await releasePushDevice(vi.fn().mockRejectedValue(new Error("offline")));
    expect(storedDeviceId()).toBeNull();
    const remove = vi.fn();
    await releasePushDevice(remove);
    expect(remove).not.toHaveBeenCalled();
  });
});
