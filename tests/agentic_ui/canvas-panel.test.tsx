// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The canvas panel (plan 44, Phases 4.1–4.2), over a mocked bridge.
 *
 * Pinned: a skeleton while the document loads; the document rendered from its
 * markdown with its title, the author and version in the byline; on a desktop
 * it opens for editing (the mode menu says Editing, the surface is editable,
 * the toolbar is there), on a phone for reading with the ✎ button that
 * switches; the title's ▾ menu switching documents; an earlier version read
 * from the version menu, read-only, with a way back; a 404 says the document
 * is gone and offers the file's normal preview; any other failure offers
 * Retry. Saving itself is pinned in `canvas-editing.test.tsx`.
 */

const { api } = vi.hoisted(() => ({
  api: {
    listConversationDocuments: vi.fn(),
    getLatestDocument: vi.fn(),
    listDocumentVersions: vi.fn(),
    getDocumentVersion: vi.fn(),
    saveDocumentVersion: vi.fn(),
  },
}));
vi.mock("@/shared/lib/api", () => api);

import DocumentCanvas from "@/features/canvas/components/DocumentCanvas";
import { ApiError } from "@/shared/lib/http";
import type { CanvasDocumentVersion } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const PATH = "/conversation/output/brief.md";

const version = (over: Partial<CanvasDocumentVersion> = {}): CanvasDocumentVersion => ({
  path: PATH,
  name: "brief.md",
  version: 2,
  author: "agent",
  baseVersion: 1,
  createdAt: "2026-11-18T09:40:00Z",
  sizeBytes: 80,
  content: "# The brief\n\nThe first release covers **versions**.\n\n## Scope\n\nRead-only.\n",
  ...over,
});

function renderCanvas(props: Partial<React.ComponentProps<typeof DocumentCanvas>> = {}) {
  const handlers = { onSelectPath: vi.fn(), onClose: vi.fn(), onToggleFullscreen: vi.fn() };
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <DocumentCanvas
          userId="user-1"
          conversationId="conv-1"
          path={PATH}
          revision="0"
          compact={false}
          canToggleFullscreen
          fullscreen={false}
          onPreviewFile={null}
          {...handlers}
          {...props}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return handlers;
}

beforeEach(() => {
  for (const fn of Object.values(api)) fn.mockReset();
  api.listConversationDocuments.mockResolvedValue([
    { path: PATH, name: "brief.md", version: 2, author: "agent", updatedAt: "", sizeBytes: 80 },
    {
      path: "/conversation/output/notes.md",
      name: "notes.md",
      version: 1,
      author: "user",
      updatedAt: "",
      sizeBytes: 9,
    },
  ]);
});

describe("document canvas", () => {
  it("shows a skeleton, then the document for editing with its byline", async () => {
    let resolve: (value: CanvasDocumentVersion) => void = () => {};
    api.getLatestDocument.mockReturnValue(new Promise((done) => (resolve = done)));
    renderCanvas();

    expect(screen.getByLabelText("Loading the document")).toBeInTheDocument();
    resolve(version());

    expect(await screen.findByRole("heading", { level: 1, name: "The brief" })).toBeInTheDocument();
    expect(api.getLatestDocument).toHaveBeenCalledWith("user-1", "conv-1", PATH, expect.anything());
    expect(screen.getByText("versions")).toBeInTheDocument();
    expect(screen.getByLabelText("Written by the agent")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Version 2, the latest/ })).toBeInTheDocument();
    // A desktop opens for editing: the mode menu, an editable surface, the toolbar.
    expect(screen.getByRole("button", { name: "Mode: Editing. Change mode" })).toBeInTheDocument();
    expect(screen.getByLabelText("brief, editing")).toHaveAttribute("contenteditable", "true");
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(screen.queryByLabelText("Loading the document")).not.toBeInTheDocument();
  });

  it("opens for reading on a phone, and the pencil switches to editing", async () => {
    api.getLatestDocument.mockResolvedValue(version());
    renderCanvas({ compact: true });
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    expect(screen.getByLabelText("brief, read-only")).not.toHaveAttribute(
      "contenteditable",
      "true",
    );
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Edit document" }));
    expect(await screen.findByLabelText("brief, editing")).toHaveAttribute(
      "contenteditable",
      "true",
    );
    expect(screen.getByRole("toolbar", { name: "Formatting" })).toBeInTheDocument();
  });

  it("switches to another document of the conversation from the title menu", async () => {
    api.getLatestDocument.mockResolvedValue(version());
    const { onSelectPath } = renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Document: brief/ }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: "notes" }));
    expect(onSelectPath).toHaveBeenCalledWith("/conversation/output/notes.md");
  });

  it("reads an earlier version from the version menu, and goes back", async () => {
    api.getLatestDocument.mockResolvedValue(version());
    api.listDocumentVersions.mockResolvedValue([
      {
        version: 2,
        author: "agent",
        baseVersion: 1,
        createdAt: "2026-11-18T09:40:00Z",
        sizeBytes: 80,
      },
      {
        version: 1,
        author: "user",
        baseVersion: null,
        createdAt: "2026-11-17T09:40:00Z",
        sizeBytes: 60,
      },
    ]);
    api.getDocumentVersion.mockResolvedValue(
      version({ version: 1, author: "user", content: "# The first draft\n" }),
    );
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    fireEvent.pointerDown(screen.getByRole("button", { name: /^Version 2/ }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitem", { name: /^v1/ }));

    expect(
      await screen.findByRole("heading", { level: 1, name: "The first draft" }),
    ).toBeInTheDocument();
    expect(api.getDocumentVersion).toHaveBeenCalledWith(
      "user-1",
      "conv-1",
      PATH,
      1,
      expect.anything(),
    );
    expect(screen.getByLabelText("Written by you")).toBeInTheDocument();
    // An earlier version is read-only: no mode menu, no toolbar.
    expect(screen.getByLabelText("brief, read-only")).not.toHaveAttribute(
      "contenteditable",
      "true",
    );
    expect(screen.queryByRole("toolbar", { name: "Formatting" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show the latest" }));
    expect(await screen.findByRole("heading", { level: 1, name: "The brief" })).toBeInTheDocument();
  });

  it("says a 404 document is gone and offers the file's preview", async () => {
    api.getLatestDocument.mockRejectedValue(new ApiError("Not found", { status: 404 }));
    const onPreviewFile = vi.fn();
    const { onClose } = renderCanvas({ onPreviewFile });

    expect(await screen.findByText("This document is no longer available")).toBeInTheDocument();
    // A 404 is an answer, not a fault: asked once, never retried.
    expect(api.getLatestDocument).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Preview the file" }));
    expect(onPreviewFile).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("offers Retry when the document fails to load for another reason", async () => {
    api.getLatestDocument.mockRejectedValue(new ApiError("Bridge down", { status: 503 }));
    renderCanvas();

    expect(await screen.findByText("Bridge down", {}, { timeout: 3000 })).toBeInTheDocument();
    api.getLatestDocument.mockResolvedValue(version());
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { level: 1, name: "The brief" })).toBeInTheDocument(),
    );
  });
});
