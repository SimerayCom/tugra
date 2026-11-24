import { ConflictException, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createHmac } from "node:crypto";
import { PrismaService } from "../prisma/prisma.service";
import { CryptoService } from "../crypto/crypto.service";
import { MailService } from "../mail/mail.service";
import { StatusSubscribersService } from "./status-subscribers.service";

const crypto = {
  hmac: (d: string) => createHmac("sha256", "k1").update(d).digest("hex"),
  hmacCandidates: (d: string) => ["k1", "k0"].map((k) => createHmac("sha256", k).update(d).digest("hex")),
} as unknown as CryptoService;
const config = { get: () => "https://panel.example.com" } as unknown as ConfigService;

function make(prisma: unknown, mailConfigured = true) {
  const send = jest.fn().mockResolvedValue(true);
  const mail = { isConfigured: () => mailConfigured, send } as unknown as MailService;
  return { svc: new StatusSubscribersService(prisma as PrismaService, mail, crypto, config), send };
}

describe("StatusSubscribersService tokens", () => {
  const { svc } = make({});
  it("verifies its own tokens, per kind, and also ones made under a previous key", () => {
    const t = svc.token("unsub", "sub1");
    expect(svc.verifyToken("unsub", t)).toBe("sub1");
    expect(svc.verifyToken("confirm", t)).toBeNull();
    const old = `sub1.${createHmac("sha256", "k0").update("status:unsub:sub1").digest("hex")}`;
    expect(svc.verifyToken("unsub", old)).toBe("sub1");
  });
  it("rejects forged and malformed tokens", () => {
    expect(svc.verifyToken("unsub", "sub1.deadbeef")).toBeNull();
    expect(svc.verifyToken("unsub", "sub2." + svc.token("unsub", "sub1").split(".")[1])).toBeNull();
    expect(svc.verifyToken("unsub", "nodot")).toBeNull();
    expect(svc.verifyToken("unsub", ".x")).toBeNull();
  });
});

describe("StatusSubscribersService.subscribe", () => {
  const pageRow = { id: "p1", title: "Acme", slug: "acme" };
  it("emails a confirm link and stores an unconfirmed row", async () => {
    const prisma = {
      statusPage: { findFirst: jest.fn().mockResolvedValue(pageRow) },
      statusSubscriber: { findUnique: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({ id: "sub1" }) },
    };
    const { svc, send } = make(prisma);
    await svc.subscribe("acme", "a@example.com");
    expect(prisma.statusSubscriber.create).toHaveBeenCalledWith({ data: { pageId: "p1", email: "a@example.com" } });
    const [to, mail] = send.mock.calls[0];
    expect(to).toBe("a@example.com");
    expect(mail.text).toContain("https://panel.example.com/status/acme/email?action=confirm&token=sub1.");
  });
  it("says nothing new for an already confirmed address (no enumeration)", async () => {
    const prisma = {
      statusPage: { findFirst: jest.fn().mockResolvedValue(pageRow) },
      statusSubscriber: { findUnique: jest.fn().mockResolvedValue({ id: "sub1", confirmedAt: new Date() }) },
    };
    const { svc, send } = make(prisma);
    await expect(svc.subscribe("acme", "a@example.com")).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
  it("is unavailable without mail, and 404s an unpublished page", async () => {
    const prisma = { statusPage: { findFirst: jest.fn().mockResolvedValue(pageRow) } };
    await expect(make(prisma, false).svc.subscribe("acme", "a@example.com")).rejects.toThrow(ConflictException);
    await expect(make({ statusPage: { findFirst: jest.fn().mockResolvedValue(null) } }).svc.subscribe("x", "a@example.com")).rejects.toThrow(NotFoundException);
  });
});

describe("StatusSubscribersService confirm / unsubscribe / notify", () => {
  it("confirms and unsubscribes by token only", async () => {
    const row = { id: "sub1", confirmedAt: null, page: { slug: "acme" } };
    const prisma = { statusSubscriber: { findUnique: jest.fn().mockResolvedValue(row), update: jest.fn(), delete: jest.fn() } };
    const { svc } = make(prisma);
    await expect(svc.confirm("bad")).rejects.toThrow(NotFoundException);
    await expect(svc.confirm(svc.token("confirm", "sub1"))).resolves.toEqual({ slug: "acme" });
    expect(prisma.statusSubscriber.update).toHaveBeenCalledWith({ where: { id: "sub1" }, data: { confirmedAt: expect.any(Date) } });
    await expect(svc.unsubscribe(svc.token("confirm", "sub1"))).rejects.toThrow(NotFoundException);
    await svc.unsubscribe(svc.token("unsub", "sub1"));
    expect(prisma.statusSubscriber.delete).toHaveBeenCalledWith({ where: { id: "sub1" } });
  });

  it("mails every confirmed subscriber with the page label and an unsubscribe link, never the monitor target", async () => {
    const prisma = {
      statusPageMonitor: { findMany: jest.fn().mockResolvedValue([{ label: "API", monitor: { name: "api-prod-1" }, page: { id: "p1", slug: "acme", title: "Acme" } }]) },
      statusSubscriber: { findMany: jest.fn().mockResolvedValue([{ id: "s1", email: "a@example.com" }, { id: "s2", email: "b@example.com" }]) },
    };
    const { svc, send } = make(prisma);
    await svc.notifyMonitor("m1", "DOWN");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][1].subject).toBe("Acme: API is having issues");
    expect(send.mock.calls[0][1].text).toContain("action=unsubscribe");
    expect(JSON.stringify(send.mock.calls)).not.toContain("api-prod-1");
  });

  it("does nothing without mail", async () => {
    const prisma = { statusPageMonitor: { findMany: jest.fn() } };
    await make(prisma, false).svc.notifyMonitor("m1", "UP");
    expect(prisma.statusPageMonitor.findMany).not.toHaveBeenCalled();
  });
});
