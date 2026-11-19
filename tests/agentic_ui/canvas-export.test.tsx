// @vitest-environment happy-dom
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Export and Office previews (plan 44, Phase 4.5).
 *
 * Pinned: the export call posts the path, format and version with the CSRF
 * token, hands back the file under the server's name (or the title), and
 * words a 503 / 504 for the user; the header's Export panel exports the shown
 * saved version in each format and downloads it, waits with a spinner on the
 * picked row and then says it is done, copies the markdown, says unsaved
 * edits aren't included (Save first saves, the next export takes the new
 * version), and shows a refused export as a toast; an Office
 * attachment previews through `preview.pdf` in the PDF viewer, and falls back
 * to the old preview when that fails.
 */

const { api, http, download, toast } = vi.hoisted(() => ({
  api: {
    listConversationDocuments: vi.fn(),
    getLatestDocument: vi.fn(),
    listDocumentVersions: vi.fn(),
    getDocumentVersion: vi.fn(),
    saveDocumentVersion: vi.fn(),
    listDocumentComments: vi.fn(),
    exportDocument: vi.fn(),
    fetchAttachmentPreviewBlob: vi.fn(),
    fetchAttachmentPreviewPdf: vi.fn(),
    fetchDocxPreviewToken: vi.fn(),
  },
  http: { requestRaw: vi.fn() },
  download: { triggerBrowserDownload: vi.fn() },
  toast: vi.fn(),
}));
vi.mock("@/shared/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/lib/api")>();
  return { ...api, wire: actual };
});
vi.mock("@/shared/lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/http")>()),
  requestRaw: http.requestRaw,
}));
vi.mock("@/shared/lib/download", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/download")>()),
  triggerBrowserDownload: download.triggerBrowserDownload,
}));
vi.mock("@/shared/hooks/use-toast", () => ({ useToast: () => ({ toast, dismiss: vi.fn() }) }));
// The previews are iframes the test DOM would try to load: stand-ins say what they got.
vi.mock("@/features/attachments/components/attachment_preview_parts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/attachments/components/attachment_preview_parts")
  >()),
  PdfPreview: ({ url }: { url: string }) => <div data-testid="pdf-preview">{url}</div>,
  DocxPreview: ({ viewerUrl }: { viewerUrl: string }) => (
    <div data-testid="office-viewer">{viewerUrl}</div>
  ),
}));

import AttachmentPreviewPanel from "@/features/attachments/components/AttachmentPreviewPanel";
import DocumentCanvas from "@/features/canvas/components/DocumentCanvas";
import * as apiModule from "@/shared/lib/api";
import { ApiError } from "@/shared/lib/http";
import type { CanvasDocumentVersion } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

const wire = (apiModule as unknown as { wire: typeof import("@/shared/lib/api") }).wire;
const PATH = "/conversation/output/brief.md";

const latest = (): CanvasDocumentVersion => ({
  path: PATH,
  name: "brief.md",
  version: 3,
  author: "agent",
  baseVersion: 2,
  createdAt: "2026-11-18T09:40:00Z",
  sizeBytes: 80,
  content: "# The brief\n\nIntro text.\n",
});

describe("the export call", () => {
  beforeEach(() => http.requestRaw.mockReset());

  it("posts the request and names the file from Content-Disposition", async () => {
    http.requestRaw.mockResolvedValue(
      new Response("PDF", {
        headers: {
          "Content-Disposition":
            "attachment; filename=\"document.pdf\"; filename*=UTF-8''%CE%A3%CF%87%CE%AD%CE%B4%CE%B9%CE%BF.pdf",
        },
      }),
    );
    const file = await wire.exportDocument(
      "user-1",
      "conv-1",
      { path: PATH, format: "pdf", version: 3 },
      "brief.pdf",
    );
    const [url, options] = http.requestRaw.mock.calls[0];
    expect(url).toBe("/api/v1/conversations/user-1/conv-1/documents/export");
    expect(options).toMatchObject({
      method: "POST",
      csrf: true,
      accept: "application/pdf",
      body: { path: PATH, format: "pdf", version: 3 },
    });
    expect(file.filename).toBe("Σχέδιο.pdf");
    expect(await file.blob.text()).toBe("PDF");
  });

  it("falls back to the title, and words the sandbox's 503 and 504", async () => {
    http.requestRaw.mockResolvedValue(new Response("# md"));
    expect(
      (await wire.exportDocument("u", "c", { path: PATH, format: "md" }, "brief.md")).filename,
    ).toBe("brief.md");
    expect(http.requestRaw.mock.calls[0][1].body).toEqual({ path: PATH, format: "md" });
    expect(http.requestRaw.mock.calls[0][1].errorMessages).toMatchObject({
      502: "The export failed",
      503: "Export needs the sandbox, which isn't available right now",
      504: expect.stringContaining("took too long"),
    });
  });
});

function renderCanvas() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
          onSelectPath={vi.fn()}
          onClose={vi.fn()}
          onToggleFullscreen={vi.fn()}
        />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const openExport = async () => {
  fireEvent.click(screen.getByRole("button", { name: "Export" }));
  return screen.findByRole("dialog", { name: "Export the document" });
};

describe("Export panel in the canvas header", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    download.triggerBrowserDownload.mockReset();
    toast.mockReset();
    api.listConversationDocuments.mockResolvedValue([]);
    api.listDocumentVersions.mockResolvedValue([]);
    api.listDocumentComments.mockResolvedValue([]);
    api.getLatestDocument.mockResolvedValue(latest());
  });

  it.each([
    ["Word", "docx"],
    ["PDF", "pdf"],
    ["Markdown", "md"],
  ])("%s exports the saved version, downloads it and says so", async (label, format) => {
    const blob = new Blob(["x"]);
    let done: (value: unknown) => void = () => {};
    api.exportDocument.mockReturnValue(new Promise((resolve) => (done = resolve)));
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });

    const panel = await openExport();
    fireEvent.click(within(panel).getByRole("button", { name: `Download as ${label}` }));
    expect(api.exportDocument).toHaveBeenCalledWith(
      "user-1",
      "conv-1",
      { path: PATH, format, version: 3 },
      `brief.${format}`,
    );
    // A spinner on the picked row while the file is made.
    expect(within(panel).getByText("Preparing the file…")).toBeInTheDocument();
    await act(async () => done({ blob, filename: `The brief.${format}` }));
    expect(download.triggerBrowserDownload).toHaveBeenCalledWith(blob, `The brief.${format}`);
    // The panel stays, with the row saying it is done.
    expect(await within(panel).findByText("Downloaded")).toBeInTheDocument();
  });

  it("the trigger is the download icon alone; each row is a bare file mark, a title and one line", async () => {
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const trigger = screen.getByRole("button", { name: "Export" });
    // No ▾: one icon, the download arrow.
    expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    expect(trigger.querySelector("svg")).toHaveClass("lucide-download");
    expect(trigger.querySelector(".lucide-chevron-down")).toBeNull();

    const panel = await openExport();
    for (const [label, hint] of [
      ["Word", "Editable .docx document"],
      ["PDF", "Document for printing and sharing"],
      ["Markdown", "Plain-text .md file"],
    ]) {
      const row = within(panel).getByRole("button", { name: `Download as ${label}` });
      expect(row).toHaveTextContent(hint);
      // The mark sits bare (no tile behind it), 24px.
      const mark = row.firstElementChild as HTMLElement;
      expect(mark).toHaveClass("size-6");
      expect(mark.className).not.toMatch(/bg-|shadow|border/);
    }
    expect(within(panel).getByRole("button", { name: "Download as PDF" })).toHaveTextContent(
      /^PDF/,
    );
  });

  it("says why an export failed", async () => {
    api.exportDocument.mockRejectedValue(
      new ApiError("Export needs the sandbox, which isn't available right now", { status: 503 }),
    );
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    fireEvent.click(within(await openExport()).getByRole("button", { name: "Download as PDF" }));
    await waitFor(() =>
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't export the document",
          description: "Export needs the sandbox, which isn't available right now",
          variant: "destructive",
        }),
      ),
    );
    expect(download.triggerBrowserDownload).not.toHaveBeenCalled();
  });

  it("copies the version's markdown to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    const panel = await openExport();
    fireEvent.click(within(panel).getByRole("button", { name: "Copy as Markdown" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("# The brief\n\nIntro text.\n"));
    expect(await within(panel).findByText("Copied to the clipboard")).toBeInTheDocument();
  });

  it("with unsaved edits exports the saved version, and Save first saves then exports the new one", async () => {
    api.exportDocument.mockResolvedValue({ blob: new Blob(["x"]), filename: "brief.docx" });
    api.saveDocumentVersion.mockResolvedValue({
      kind: "saved",
      path: PATH,
      version: 4,
      createdAt: "2026-11-18T10:00:00Z",
    });
    renderCanvas();
    await screen.findByRole("heading", { level: 1, name: "The brief" });
    // An edit: a table from the pill (typing does not reach Slate in happy-dom).
    const table = screen.getByRole("button", { name: "Table" });
    fireEvent.pointerDown(table, { button: 0, pointerType: "mouse" });
    fireEvent.click(table);
    fireEvent.click(await screen.findByRole("button", { name: "Insert a table, 2 by 3" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByText("Unsaved changes")).toBeInTheDocument();

    const panel = await openExport();
    // No dialog in the way: the panel says what the export holds.
    expect(within(panel).getByText("Unsaved changes aren't included.")).toBeInTheDocument();
    fireEvent.click(within(panel).getByRole("button", { name: "Download as Word" }));
    await waitFor(() =>
      expect(api.exportDocument).toHaveBeenCalledWith(
        "user-1",
        "conv-1",
        { path: PATH, format: "docx", version: 3 },
        "brief.docx",
      ),
    );
    expect(api.saveDocumentVersion).not.toHaveBeenCalled();

    fireEvent.click(within(panel).getByRole("button", { name: "Save first" }));
    await waitFor(() => expect(api.saveDocumentVersion).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(within(panel).queryByText("Unsaved changes aren't included.")).not.toBeInTheDocument(),
    );
    fireEvent.click(within(panel).getByRole("button", { name: "Download as PDF" }));
    await waitFor(() =>
      expect(api.exportDocument).toHaveBeenLastCalledWith(
        "user-1",
        "conv-1",
        { path: PATH, format: "pdf", version: 4 },
        "brief.pdf",
      ),
    );
  });
});

describe("Office previews as PDF", () => {
  beforeEach(() => {
    for (const fn of Object.values(api)) fn.mockReset();
    URL.createObjectURL = vi.fn(() => "blob:office-pdf");
    URL.revokeObjectURL = vi.fn();
  });

  const renderPanel = () =>
    render(
      <AttachmentPreviewPanel
        preview={{
          attachment: {
            id: "att-7",
            name: "deck.pptx",
            mime: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            blobId: "blob-7",
            size: 4096,
          },
          message: { id: "msg-1" },
        }}
        userId="user-1"
        conversationId="conv-1"
        onClose={vi.fn()}
        onDownload={vi.fn()}
      />,
    );

  it("renders the server's PDF in the PDF viewer", async () => {
    api.fetchAttachmentPreviewPdf.mockResolvedValue(new Blob(["%PDF"]));
    renderPanel();
    expect(await screen.findByTestId("pdf-preview")).toHaveTextContent("blob:office-pdf");
    expect(api.fetchAttachmentPreviewPdf).toHaveBeenCalledWith("user-1", "att-7");
    expect(api.fetchDocxPreviewToken).not.toHaveBeenCalled();
  });

  it.each([503, 504, 502, 415, 413, 429])("falls back to the old preview on %i", async (status) => {
    api.fetchAttachmentPreviewPdf.mockRejectedValue(new ApiError("No box", { status }));
    api.fetchDocxPreviewToken.mockResolvedValue({ token: "tok" });
    renderPanel();
    expect(await screen.findByTestId("office-viewer")).toHaveTextContent(
      "view.officeapps.live.com",
    );
    expect(api.fetchDocxPreviewToken).toHaveBeenCalledWith({
      userId: "user-1",
      conversationId: "conv-1",
      messageId: "msg-1",
      blobId: "blob-7",
    });
  });
});
