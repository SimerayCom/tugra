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
});
