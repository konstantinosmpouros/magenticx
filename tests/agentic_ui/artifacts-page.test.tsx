// @vitest-environment happy-dom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Artifacts page (plan 44): every file of the user's, across conversations.
 *
 * Pinned: the contract drops rows the blob routes could not open and defaults
 * an unknown type; the filters and the debounced search go to the bridge (not
 * a client-side filter over one page); "Load more" follows the cursor; the two
 * empty states say different things and offer different ways out; each row
 * previews against its OWN conversation (not the open chat), downloads with its
 * own ids, and opens its conversation.
 */

const { api } = vi.hoisted(() => ({
  api: {
    listUserFiles: vi.fn(),
    downloadAttachment: vi.fn(),
    fetchAttachmentBlob: vi.fn(),
    fetchAttachmentPreviewBlob: vi.fn(),
    fetchDocxPreviewToken: vi.fn(),
  },
}));
vi.mock("@/shared/lib/api", () => api);

import ArtifactsPage from "@/features/artifacts/components/ArtifactsPage";
import { ARTIFACTS_PATH, isArtifactsPath } from "@/features/artifacts/lib/routes";
import { UserFilesPageSchema } from "@/shared/lib/schemas";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";

const file = (over: Record<string, unknown> = {}) => ({
  attachmentId: "att-1",
  blobId: "blob-1",
  fileName: "report.pdf",
  mime: "application/pdf",
  size: 2048,
  kind: "output",
  type: "pdf",
  conversationId: "conv-1",
  conversationTitle: "Quarterly numbers",
  messageId: "msg-1",
  createdAt: "2026-11-17T10:00:00Z",
  presented: true,
  title: "Q3 report",
  summary: null,
  ...over,
});

const page = (items: Record<string, unknown>[], nextCursor: string | null = null) =>
  UserFilesPageSchema.parse({ items, nextCursor });

function renderPage(props: Partial<React.ComponentProps<typeof ArtifactsPage>> = {}) {
  const onOpenConversation = vi.fn();
  const onOpenCanvas = vi.fn();
  const onStartChat = vi.fn();
  render(
    <TooltipProvider>
      <SidebarProvider defaultOpen>
        <ArtifactsPage
          userId="user-1"
          onOpenConversation={onOpenConversation}
          onOpenCanvas={onOpenCanvas}
          onStartChat={onStartChat}
          {...props}
        />
      </SidebarProvider>
    </TooltipProvider>,
  );
  return { onOpenConversation, onOpenCanvas, onStartChat };
}

const lastParams = () => api.listUserFiles.mock.calls.at(-1)?.[1];

beforeEach(() => {
  Object.values(api).forEach((fn) => fn.mockReset());
  URL.createObjectURL = vi.fn(() => "blob:preview");
  URL.revokeObjectURL = vi.fn();
});

describe("the files contract and route", () => {
  it("drops rows the blob routes could not open and defaults the rest", () => {
    const parsed = page([
      file(),
      file({ attachmentId: "att-2", blobId: "" }),
      file({ attachmentId: "att-3", messageId: undefined }),
      file({ attachmentId: "att-4", type: "video", kind: "weird", size: "big", conversationTitle: "" }),
    ]);
    expect(parsed.items.map((item) => item.attachmentId)).toEqual(["att-1", "att-4"]);
    expect(parsed.items[1]).toMatchObject({ type: "other", kind: "input", size: null, conversationTitle: null });
    expect(parsed.nextCursor).toBeNull();
  });

  it("matches the Artifacts path and nothing that merely starts with the word", () => {
    expect(ARTIFACTS_PATH).toBe("/artifacts");
    expect(isArtifactsPath("/artifacts")).toBe(true);
    expect(isArtifactsPath("/artifacts/x")).toBe(true);
    expect(isArtifactsPath("/artifactsx")).toBe(false);
    expect(isArtifactsPath("/c/artifacts")).toBe(false);
  });
});

describe("the Artifacts page", () => {
  it("lists the user's files with their conversation, date and size", async () => {
    api.listUserFiles.mockResolvedValue(
      page([file(), file({ attachmentId: "att-2", fileName: "notes.md", type: "text", kind: "input", conversationTitle: null })]),
    );
    renderPage();

    const rows = await screen.findAllByTestId("artifact-row");
    expect(rows).toHaveLength(2);
    expect(api.listUserFiles).toHaveBeenCalledWith(
      "user-1",
      expect.objectContaining({ kind: null, type: null, q: null, cursor: null }),
    );
    expect(within(rows[0]).getByText("report.pdf")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Quarterly numbers")).toBeInTheDocument();
    expect(within(rows[0]).getByText("Output")).toBeInTheDocument();
    expect(within(rows[0]).getByText("2.0 KB")).toBeInTheDocument();
    expect(within(rows[0]).getByText(/2026/)).toBeInTheDocument();
    expect(within(rows[1]).getByText("Input")).toBeInTheDocument();
    expect(within(rows[1]).getByText("Untitled conversation")).toBeInTheDocument();
  });

  it("sends the kind and type filters to the bridge", async () => {
    api.listUserFiles.mockResolvedValue(page([file()]));
    renderPage();
    await screen.findAllByTestId("artifact-row");

    fireEvent.click(screen.getByRole("button", { name: "Outputs" }));
    await waitFor(() => expect(lastParams()).toMatchObject({ kind: "output", type: null }));
    expect(screen.getByRole("button", { name: "Outputs" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Sheets" }));
    await waitFor(() => expect(lastParams()).toMatchObject({ kind: "output", type: "sheet" }));

    fireEvent.click(screen.getByRole("button", { name: "Inputs" }));
    await waitFor(() => expect(lastParams()).toMatchObject({ kind: "input", type: "sheet" }));
  });

  it("searches by name once typing pauses", async () => {
    api.listUserFiles.mockResolvedValue(page([file()]));
    renderPage();
    await screen.findAllByTestId("artifact-row");
    const callsBefore = api.listUserFiles.mock.calls.length;

    fireEvent.change(screen.getByLabelText("Search files by name"), { target: { value: "rep" } });
    fireEvent.change(screen.getByLabelText("Search files by name"), { target: { value: "report" } });

    await waitFor(() => expect(lastParams()).toMatchObject({ q: "report" }));
    // One request for the pause, not one per keystroke.
    expect(api.listUserFiles.mock.calls.length).toBe(callsBefore + 1);
  });

  it("loads the next page through the cursor", async () => {
    api.listUserFiles
      .mockResolvedValueOnce(page([file()], "cursor-2"))
      .mockResolvedValueOnce(page([file({ attachmentId: "att-2", fileName: "older.pdf" })]));
    renderPage();
    await screen.findAllByTestId("artifact-row");

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    await waitFor(() => expect(screen.getAllByTestId("artifact-row")).toHaveLength(2));
    expect(lastParams()).toMatchObject({ cursor: "cursor-2" });
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("keeps a bounded number of rows in the DOM however many pages load (plan 45)", async () => {
    const files = Array.from({ length: 200 }, (_, i) =>
      file({ attachmentId: `att-${i}`, fileName: `file-${i}.pdf` }),
    );
    api.listUserFiles.mockResolvedValue(page(files));
    renderPage();

    const rows = await screen.findAllByTestId("artifact-row");
    expect(rows.length).toBeGreaterThan(5);
    expect(rows.length).toBeLessThan(40);
    expect(screen.getByText("file-0.pdf")).toBeInTheDocument();
    expect(screen.queryByText("file-199.pdf")).toBeNull();
  });

  it("with no files at all, says where files come from and offers a chat", async () => {
    api.listUserFiles.mockResolvedValue(page([]));
    const { onStartChat } = renderPage();

    const empty = await screen.findByTestId("artifacts-empty");
    expect(within(empty).getByText("No files yet")).toBeInTheDocument();
    fireEvent.click(within(empty).getByRole("button", { name: "Start a chat" }));
    expect(onStartChat).toHaveBeenCalled();
  });

  it("with a filter that matches nothing, offers to clear it", async () => {
    api.listUserFiles.mockResolvedValueOnce(page([file()])).mockResolvedValue(page([]));
    renderPage();
    await screen.findAllByTestId("artifact-row");

    fireEvent.click(screen.getByRole("button", { name: "Slides" }));
    const empty = await screen.findByTestId("artifacts-empty");
    expect(within(empty).getByText("No files match")).toBeInTheDocument();

    fireEvent.click(within(empty).getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastParams()).toMatchObject({ kind: null, type: null, q: null }));
    expect(screen.getByRole("button", { name: "Any type" })).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the error with a retry when the list cannot load", async () => {
    api.listUserFiles.mockRejectedValueOnce(new Error("Bridge down")).mockResolvedValue(page([file()]));
    renderPage();

    expect(await screen.findByText("Bridge down")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findAllByTestId("artifact-row")).toHaveLength(1);
  });

  it("downloads with the file's own ids and opens its conversation", async () => {
    api.listUserFiles.mockResolvedValue(page([file()]));
    api.downloadAttachment.mockResolvedValue(undefined);
    const { onOpenConversation } = renderPage();
    await screen.findAllByTestId("artifact-row");

    fireEvent.click(screen.getByRole("button", { name: "Download report.pdf" }));
    await waitFor(() =>
      expect(api.downloadAttachment).toHaveBeenCalledWith({
        userId: "user-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        blobId: "blob-1",
        filename: "report.pdf",
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Open conversation Quarterly numbers" }));
    expect(onOpenConversation).toHaveBeenCalledWith("conv-1");
  });

  it("offers the same actions in one menu for a phone", async () => {
    api.listUserFiles.mockResolvedValue(page([file()]));
    api.downloadAttachment.mockResolvedValue(undefined);
    const { onOpenConversation } = renderPage();
    await screen.findAllByTestId("artifact-row");

    // A finger: the menu opens on the tap's click (useTouchMenuTrigger).
    const trigger = screen.getByRole("button", { name: "Actions for report.pdf" });
    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger, { detail: 1 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Download" }));
    await waitFor(() => expect(api.downloadAttachment).toHaveBeenCalledTimes(1));

    fireEvent.pointerDown(trigger, { pointerType: "touch" });
    fireEvent.click(trigger, { detail: 1 });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open conversation" }));
    expect(onOpenConversation).toHaveBeenCalledWith("conv-1");
  });

  it("opens a generated .md in the canvas of its conversation, and only that", async () => {
    api.listUserFiles.mockResolvedValue(
      page([
        file({ attachmentId: "a-md", fileName: "brief.md", mime: "text/markdown", type: "text", conversationId: "conv-9" }),
        file({
          attachmentId: "a-nested",
          fileName: "plan.md",
          mime: "text/markdown",
          type: "text",
          source_path: "/conversation/output/drafts/plan.md",
        }),
        file({ attachmentId: "a-in", fileName: "notes.md", mime: "text/markdown", type: "text", kind: "input" }),
      ]),
    );
    const { onOpenCanvas } = renderPage();
    await screen.findAllByTestId("artifact-row");

    // The name and the action both open it; the presented path wins over the name.
    fireEvent.click(screen.getByRole("button", { name: "brief.md" }));
    expect(onOpenCanvas).toHaveBeenLastCalledWith("conv-9", "/conversation/output/brief.md");
    fireEvent.click(screen.getByRole("button", { name: "Open plan.md in canvas" }));
    expect(onOpenCanvas).toHaveBeenLastCalledWith("conv-1", "/conversation/output/drafts/plan.md");
    // An upload is never a canvas document.
    expect(screen.queryByRole("button", { name: "Open notes.md in canvas" })).not.toBeInTheDocument();
    expect(onOpenCanvas).toHaveBeenCalledTimes(2);
  });

  it("previews a document in the preview panel, against the file's own conversation", async () => {
    // A markdown file, not a PDF: the PDF renderer is an iframe, which the
    // test DOM tries (and fails, noisily) to load.
    api.listUserFiles.mockResolvedValue(
      page([file({ fileName: "brief.md", mime: "text/markdown", type: "text", conversationId: "conv-9" })]),
    );
    api.fetchAttachmentPreviewBlob.mockResolvedValue(new Blob(["# The brief"], { type: "text/markdown" }));
    renderPage();
    await screen.findAllByTestId("artifact-row");

    fireEvent.click(screen.getByRole("button", { name: "Preview brief.md" }));

    await waitFor(() =>
      expect(api.fetchAttachmentPreviewBlob).toHaveBeenCalledWith({
        userId: "user-1",
        conversationId: "conv-9",
        messageId: "msg-1",
        blobId: "blob-1",
      }),
    );
    expect(await screen.findByRole("button", { name: "Close preview" })).toBeInTheDocument();
    expect(await screen.findByText("The brief")).toBeInTheDocument();
  });

  it("previews an image in the lightbox through the download route", async () => {
    api.listUserFiles.mockResolvedValue(
      page([file({ attachmentId: "img-1", blobId: "blob-img", fileName: "chart.png", mime: "image/png", type: "image" })]),
    );
    api.fetchAttachmentBlob.mockResolvedValue(new Blob(["png"], { type: "image/png" }));
    renderPage();
    await screen.findAllByTestId("artifact-row");

    fireEvent.click(screen.getByRole("button", { name: "Preview chart.png" }));

    await waitFor(() =>
      expect(api.fetchAttachmentBlob).toHaveBeenCalledWith({
        userId: "user-1",
        conversationId: "conv-1",
        messageId: "msg-1",
        blobId: "blob-img",
      }),
    );
    expect(api.fetchAttachmentPreviewBlob).not.toHaveBeenCalled();
    await waitFor(() => expect(document.querySelector('img[src="blob:preview"]')).not.toBeNull());
  });
});
