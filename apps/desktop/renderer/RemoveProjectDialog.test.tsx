import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "@dartsnut/shared-ipc";
import { RemoveProjectDialog } from "./App";

const project: ProjectRecord = {
  id: "project-1",
  name: "force_updater",
  folderPath: "/projects/force_updater",
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z",
  lastOpenedAt: "2026-08-18T00:00:00.000Z"
};

describe("remove project dialog", () => {
  it("states that local chats are removed while computer files are preserved", () => {
    const markup = renderToStaticMarkup(
      <RemoveProjectDialog
        project={project}
        removing={false}
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(markup).toContain("Remove force_updater?");
    expect(markup).toContain("all of its chats from Dartsnut Agent");
    expect(markup).toContain("Files on your computer won");
    expect(markup).toContain("Remove local project");
    expect(markup).toContain('aria-modal="true"');
  });

  it("disables dismissal and shows progress while removal runs", () => {
    const markup = renderToStaticMarkup(
      <RemoveProjectDialog
        project={project}
        removing
        error={null}
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(markup).toContain("Removing…");
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
  });

  it("renders removal failures as an alert", () => {
    const markup = renderToStaticMarkup(
      <RemoveProjectDialog
        project={project}
        removing={false}
        error="Could not remove the project cache."
        onCancel={vi.fn()}
        onConfirm={vi.fn()}
      />
    );

    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Could not remove the project cache.");
  });
});
