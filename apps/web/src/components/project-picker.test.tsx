import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React, { useState } from "react";
import { I18nProvider } from "../i18n/provider";
import { ProjectPicker, type ProjectChoice } from "./project-picker";
import { TeamPicker } from "./team-picker";

afterEach(cleanup);

function Harness({ initial = "", projects = [{ name: "Shop" }, { name: "Acme" }] as ProjectChoice[], onCreate, noneLabel, onValue }: { initial?: string; projects?: ProjectChoice[]; onCreate?: (n: string) => Promise<unknown> | void; noneLabel?: string; onValue?: (v: string) => void }) {
  const [v, setV] = useState(initial);
  return (
    <I18nProvider>
      <label htmlFor="p">Project</label>
      <ProjectPicker id="p" value={v} projects={projects} noneLabel={noneLabel} onCreate={onCreate} onChange={(n) => { setV(n); onValue?.(n); }} />
      <output data-testid="v">{v}</output>
    </I18nProvider>
  );
}

describe("ProjectPicker", () => {
  it("lists '+ New project' first, then the empty choice, then the existing projects by name", () => {
    render(<Harness noneLabel="Source project" />);
    const opts = Array.from((screen.getByLabelText("Project") as HTMLSelectElement).options).map((o) => o.textContent);
    expect(opts).toEqual(["+ New project", "Source project", "Acme", "Shop"]);
  });

  it("choosing a project reports its name", () => {
    const onValue = vi.fn();
    render(<Harness onValue={onValue} />);
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "Shop" } });
    expect(onValue).toHaveBeenCalledWith("Shop");
  });

  it("'+ New project' opens an inline name field; Create chooses it and lists it as new", async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "::new-project::" } });
    const name = screen.getByLabelText("New project name");
    fireEvent.change(name, { target: { value: "  Billing  " } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("v").textContent).toBe("Billing"));
    expect(screen.queryByLabelText("New project name")).toBeNull();
    expect(Array.from((screen.getByLabelText("Project") as HTMLSelectElement).options).map((o) => o.textContent)).toContain("Billing (new)");
  });

  it("Enter creates, Escape cancels, and a name that already exists just selects it", async () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "::new-project::" } });
    fireEvent.keyDown(screen.getByLabelText("New project name"), { key: "Escape" });
    expect(screen.queryByLabelText("New project name")).toBeNull();
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "::new-project::" } });
    const name = screen.getByLabelText("New project name");
    fireEvent.change(name, { target: { value: "shop" } });
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(screen.getByTestId("v").textContent).toBe("Shop"));
  });

  it("rejects an over-long name inline", () => {
    render(<Harness />);
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "::new-project::" } });
    const name = screen.getByLabelText("New project name");
    fireEvent.change(name, { target: { value: "x".repeat(81) } });
    fireEvent.keyDown(name, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toBe("Use a name of 1 to 80 characters.");
    expect(screen.getByTestId("v").textContent).toBe("");
  });

  it("with onCreate it waits for the call and keeps the choice only when it succeeds", async () => {
    const onCreate = vi.fn().mockRejectedValueOnce(new Error("Name taken")).mockResolvedValueOnce(undefined);
    render(<Harness onCreate={onCreate} />);
    fireEvent.change(screen.getByLabelText("Project"), { target: { value: "::new-project::" } });
    fireEvent.change(screen.getByLabelText("New project name"), { target: { value: "Billing" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Name taken");
    expect(screen.getByTestId("v").textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await waitFor(() => expect(screen.getByTestId("v").textContent).toBe("Billing"));
    expect(onCreate).toHaveBeenCalledTimes(2);
  });

  it("a value that is not in the list still shows (as new)", () => {
    render(<Harness initial="Carry" />);
    expect((screen.getByLabelText("Project") as HTMLSelectElement).value).toBe("Carry");
  });
});

describe("TeamPicker", () => {
  it("lists the teams and reports the choice", () => {
    const onChange = vi.fn();
    render(
      <I18nProvider>
        <TeamPicker ariaLabel="Team" value="t1" teams={[{ id: "t1", name: "One" }, { id: "t2", name: "Two" }]} onChange={onChange} />
      </I18nProvider>,
    );
    fireEvent.change(screen.getByLabelText("Team"), { target: { value: "t2" } });
    expect(onChange).toHaveBeenCalledWith("t2");
  });
});
