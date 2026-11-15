import { describe, it, expect, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { useState } from "react";
import { I18nProvider } from "../../i18n/provider";
import { RetentionFields, retentionFromFields, retentionToFields, type RetentionValue } from "./retention-fields";

afterEach(cleanup);

function Harness({ initial, onValue }: { initial: RetentionValue; onValue: (v: RetentionValue) => void }) {
  const [v, setV] = useState(initial);
  return <RetentionFields value={v} onChange={(n) => { setV(n); onValue(n); }} />;
}

describe("retention value helpers", () => {
  it("an empty limit becomes null; keep falls back to 7 (or null when optional)", () => {
    expect(retentionToFields({ keep: "5", days: "", sizeGb: "" })).toEqual({ retention: 5, retentionDays: null, maxSizeGb: null });
    expect(retentionToFields({ keep: "", days: "30", sizeGb: "20" })).toEqual({ retention: 7, retentionDays: 30, maxSizeGb: 20 });
    expect(retentionToFields({ keep: "", days: "", sizeGb: "" }, { keepOptional: true }).retention).toBeNull();
    expect(retentionToFields({ keep: "0", days: "-3", sizeGb: "abc" })).toEqual({ retention: 7, retentionDays: null, maxSizeGb: null });
    expect(retentionFromFields(3, null, 10)).toEqual({ keep: "3", days: "", sizeGb: "10" });
  });
});

describe("RetentionFields", () => {
  it("renders the three limits + the 'whichever first, newest kept' hint, and reports edits", () => {
    let last: RetentionValue | undefined;
    render(<I18nProvider><Harness initial={{ keep: "7", days: "", sizeGb: "" }} onValue={(v) => (last = v)} /></I18nProvider>);
    expect(screen.getByText(/Whichever limit is reached first applies\. The newest backup is always kept\./)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Max age (days)"), { target: { value: "30" } });
    fireEvent.change(screen.getByLabelText("Max total size (GB)"), { target: { value: "50" } });
    fireEvent.change(screen.getByLabelText("Keep (copies)"), { target: { value: "3" } });
    expect(last).toEqual({ keep: "3", days: "30", sizeGb: "50" });
    fireEvent.change(screen.getByLabelText("Max total size (GB)"), { target: { value: "" } });
    expect(retentionToFields(last!).retentionDays).toBe(30);
    expect(retentionToFields({ ...last!, sizeGb: "" }).maxSizeGb).toBeNull();
  });
});
