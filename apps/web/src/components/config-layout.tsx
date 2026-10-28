"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export interface ConfigLayoutGroup {
  key: string;
  label: string;
  content: ReactNode;
  icon?: LucideIcon;
}

/**
 * Coolify-style configuration layout: a left vertical sub-nav of groups and the
 * selected group's cards on the right. `groups` is already filtered to the
 * non-empty groups and ordered by the caller; `active` is guaranteed to be one of
 * them. Visited panels stay mounted (hidden with the `hidden` attribute) so a
 * half-typed draft or an in-flight fetch survives switching groups and back.
 */
export function ConfigLayout({
  groups,
  active,
  onChange,
  navLabel,
}: {
  groups: ConfigLayoutGroup[];
  active: string;
  onChange: (key: string) => void;
  navLabel: string;
}) {
  // Mount a group the first time it becomes active; never unmount it afterwards.
  const [visited, setVisited] = useState<Set<string>>(() => new Set([active]));
  useEffect(() => {
    setVisited((prev) => (prev.has(active) ? prev : new Set(prev).add(active)));
  }, [active]);

  // Keep the active pill in view on the mobile horizontal strip.
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  useEffect(() => {
    btnRefs.current[active]?.scrollIntoView?.({ inline: "center", block: "nearest" });
  }, [active]);

  return (
    <div className="cfg-layout">
      <nav aria-label={navLabel} className="cfg-nav">
        <ul>
          {groups.map((g) => {
            const on = g.key === active;
            return (
              <li key={g.key}>
                <button
                  type="button"
                  id={`cfg-nav-${g.key}`}
                  ref={(el) => {
                    btnRefs.current[g.key] = el;
                  }}
                  className="cfg-nav-item"
                  aria-current={on ? "page" : undefined}
                  aria-controls={`cfg-panel-${g.key}`}
                  onClick={() => onChange(g.key)}
                >
                  {g.icon && <g.icon size={15} aria-hidden style={{ flexShrink: 0 }} />}
                  {g.label}
                </button>
              </li>
            );
          })}
        </ul>
      </nav>
      <div className="cfg-panels">
        {groups
          .filter((g) => visited.has(g.key))
          .map((g) => (
            <section
              key={g.key}
              id={`cfg-panel-${g.key}`}
              aria-labelledby={`cfg-nav-${g.key}`}
              hidden={g.key !== active}
            >
              <h2 className="cfg-panel-title">{g.label}</h2>
              {g.content}
            </section>
          ))}
      </div>
    </div>
  );
}
