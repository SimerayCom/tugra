import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import React, { useState } from "react";
import { I18nProvider } from "../i18n/provider";
import en from "../i18n/locales/en";
import { translate } from "../i18n/translate";
import { TemplateFields, validateFields } from "./template-fields";
import type { FormField } from "../lib/types";

afterEach(cleanup);

// Real English `t`, matching what I18nProvider hands components.
const t = (k: string, vars?: Record<string, string | number>) => translate(en, k, vars);

const FIELDS: FormField[] = [
  { key: "host", type: "text", label: "Host" },
  { key: "pw", type: "password", label: "Password", required: true },
  { key: "port", type: "number", label: "Port", min: 1, max: 65535 },
  { key: "tz", type: "select", label: "Timezone", options: [{ value: "utc", label: "UTC" }, { value: "cet", label: "CET" }] },
  { key: "tls", type: "boolean", label: "Enable TLS" },
  { key: "admin", type: "password", label: "Admin password", required: true, generate: "password" },
  { key: "secret", type: "hidden", label: "Hidden secret" },
  { key: "salt", type: "random", label: "Random salt" },
];

// Controlled harness so onChange actually updates the rendered widgets.
function Harness({ fields = FIELDS }: { fields?: FormField[] }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const errors = validateFields(values, fields, t);
  return (
    <I18nProvider>
      <TemplateFields fields={fields} values={values} errors={errors} onChange={(k, v) => setValues((p) => ({ ...p, [k]: v }))} />
    </I18nProvider>
  );
}

describe("TemplateFields", () => {
  it("renders a widget per visible field and skips hidden/random", () => {
    render(<Harness />);
    expect(screen.getByLabelText("Host")).toBeTruthy();
    expect(screen.getByLabelText("Password *")).toBeTruthy(); // required, no generate → starred
    expect(screen.getByLabelText("Port")).toBeTruthy();
    expect(screen.getByLabelText("Timezone")).toBeTruthy();
    expect(screen.getByText("Enable TLS")).toBeTruthy();
    // generate-backed required field is NOT starred (server fills it)
    expect(screen.getByLabelText("Admin password")).toBeTruthy();
    expect(screen.queryByLabelText("Admin password *")).toBeNull();
    // hidden + random are omitted entirely
    expect(screen.queryByText("Hidden secret")).toBeNull();
    expect(screen.queryByText("Random salt")).toBeNull();
  });

  it("renders the number field as a numeric input with min/max", () => {
    render(<Harness />);
    const port = screen.getByLabelText("Port") as HTMLInputElement;
    expect(port.type).toBe("number");
    expect(port.min).toBe("1");
    expect(port.max).toBe("65535");
  });

  it("shows an Auto-generated placeholder on a blank generate-backed field", () => {
    render(<Harness />);
    const admin = screen.getByLabelText("Admin password") as HTMLInputElement;
    expect(admin.placeholder).toBe("Auto-generated");
  });

  it("masks the password field and toggles reveal with Show/Hide", () => {
    render(<Harness />);
    const pw = screen.getByLabelText("Password *") as HTMLInputElement;
    expect(pw.type).toBe("password");
    // Two password fields render a Show/Hide button each — scope to this field's own toggle.
    const toggle = () => pw.parentElement!.querySelector("button") as HTMLButtonElement;
    expect(toggle().textContent).toBe("Show");
    fireEvent.click(toggle());
    expect(pw.type).toBe("text");
    expect(toggle().textContent).toBe("Hide");
    fireEvent.click(toggle());
    expect(pw.type).toBe("password");
  });

  it("stores booleans as \"true\"/\"false\" strings", () => {
    render(<Harness />);
    const tls = screen.getByRole("checkbox") as HTMLInputElement;
    expect(tls.checked).toBe(false);
    fireEvent.click(tls);
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });
});

describe("validateFields", () => {
  const defs: FormField[] = [
    { key: "pw", type: "password", label: "Password", required: true },
    { key: "port", type: "number", label: "Port", min: 1, max: 65535 },
    { key: "tz", type: "select", label: "Timezone", options: [{ value: "utc", label: "UTC" }] },
    { key: "tls", type: "boolean", label: "TLS" },
    { key: "slug", type: "text", label: "Slug", regex: "^[a-z]+$" },
    { key: "admin", type: "password", label: "Admin", required: true, generate: "password" },
    // A numeric field may ALSO carry a regex/options constraint — the client must mirror the hub and
    // apply both, not stop at the numeric check.
    { key: "pin", type: "number", label: "PIN", regex: "^\\d{4}$" },
    { key: "webport", type: "port", label: "Web port", options: [{ value: "80", label: "80" }, { value: "443", label: "443" }] },
  ];

  it("flags an untouched required field (no generate)", () => {
    expect(validateFields({}, defs, t).pw).toBe("Required");
  });

  it("does NOT flag a blank required field that has generate (server fills it)", () => {
    expect(validateFields({}, defs, t).admin).toBeUndefined();
  });

  it("rejects a non-numeric number and enforces min/max", () => {
    expect(validateFields({ port: "abc" }, defs, t).port).toBe("Must be a number");
    expect(validateFields({ port: "0" }, defs, t).port).toBe("Must be at least 1");
    expect(validateFields({ port: "70000" }, defs, t).port).toBe("Must be at most 65535");
    expect(validateFields({ port: "8080" }, defs, t).port).toBeUndefined();
  });

  it("rejects a value outside the select options", () => {
    expect(validateFields({ tz: "mars" }, defs, t).tz).toBe("Choose one of the listed options");
    expect(validateFields({ tz: "utc" }, defs, t).tz).toBeUndefined();
  });

  it("rejects a boolean that is not true/false", () => {
    expect(validateFields({ tls: "maybe" }, defs, t).tls).toBe("Must be true or false");
    expect(validateFields({ tls: "true" }, defs, t).tls).toBeUndefined();
  });

  it("enforces the field regex", () => {
    expect(validateFields({ pw: "x", slug: "Bad_Slug" }, defs, t).slug).toBe("Invalid format");
    expect(validateFields({ pw: "x", slug: "ok" }, defs, t).slug).toBeUndefined();
  });

  it("also applies regex/options to a numeric field (mirrors the hub)", () => {
    // numeric-valid but regex-invalid → still flagged
    expect(validateFields({ pin: "12345" }, defs, t).pin).toBe("Invalid format");
    expect(validateFields({ pin: "1234" }, defs, t).pin).toBeUndefined();
    // numeric-valid but not an allowed option → still flagged
    expect(validateFields({ webport: "8080" }, defs, t).webport).toBe("Choose one of the listed options");
    expect(validateFields({ webport: "443" }, defs, t).webport).toBeUndefined();
  });

  it("returns no errors when all required fields are satisfied", () => {
    const errs = validateFields({ pw: "hunter2", port: "8080", tz: "utc", tls: "false", slug: "ok", pin: "1234", webport: "80" }, defs, t);
    expect(Object.keys(errs)).toHaveLength(0);
  });
});
