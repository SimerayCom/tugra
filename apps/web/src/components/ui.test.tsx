import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { FolderTree } from "lucide-react";
import { Btn, EmptyState } from "./ui";

afterEach(cleanup);

describe("EmptyState", () => {
  it("renders plain children as the description (backward compatible)", () => {
    render(<EmptyState>No projects yet.</EmptyState>);
    expect(screen.getByText("No projects yet.")).toBeTruthy();
  });

  it("renders a title and description together", () => {
    render(<EmptyState title="No projects yet">Create your first project.</EmptyState>);
    expect(screen.getByText("No projects yet")).toBeTruthy();
    expect(screen.getByText("Create your first project.")).toBeTruthy();
  });

  it("renders an icon when one is given", () => {
    const { container } = render(<EmptyState icon={FolderTree} title="Empty" />);
    expect(container.querySelector("svg")).toBeTruthy();
  });

  it("renders an action/CTA when provided", () => {
    render(<EmptyState title="Empty" action={<button>Add server</button>} />);
    expect(screen.getByText("Add server")).toBeTruthy();
  });
});

describe("Btn", () => {
  it("defaults to type=button so it does not submit a surrounding form", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    const onClick = vi.fn();
    render(
      <form onSubmit={onSubmit}>
        <Btn onClick={onClick}>Go</Btn>
      </form>,
    );
    fireEvent.click(screen.getByText("Go"));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled(); // no double-fire
  });

  it("submits the form when type=submit is set explicitly", () => {
    const onSubmit = vi.fn((e: React.FormEvent) => e.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <Btn type="submit">Save</Btn>
      </form>,
    );
    fireEvent.click(screen.getByText("Save"));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("loading marks the button busy + disabled, swaps the icon for a spinner, and blocks clicks", () => {
    const onClick = vi.fn();
    const { container } = render(<Btn icon={FolderTree} loading onClick={onClick}>Deploying</Btn>);
    const btn = screen.getByRole("button", { name: /deploying/i });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    expect(btn).toHaveProperty("disabled", true);
    expect(container.querySelector("svg")).toBeNull(); // lucide icon replaced by the spinner span
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled(); // disabled while loading
  });

  it("iconTone tints only the leading icon", () => {
    const { container } = render(<Btn icon={FolderTree} iconTone="success">Start</Btn>);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg).toBeTruthy();
    expect(svg.style.color).toContain("--c-g"); // success → green token
  });
});
