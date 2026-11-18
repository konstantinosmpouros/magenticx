// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The read-only canvas's contract and entry points (plan 44, Phase 4.1).
 *
 * Pinned: the bridge's snake_case documents answers map to camelCase, rows
 * the canvas could not open are dropped, and a version without its markdown
 * is a contract break, not an empty document; the four reads hit the bridge
 * with the path as a query parameter; `transformAttachment` keeps the
 * presented path (`sourcePath`); a file is a canvas document only as a `.md`
 * under `/conversation/output/` (`sourcePath ?? output dir + name`); and the
 * artifact card offers the canvas only where the chat provides one.
 */

const { http } = vi.hoisted(() => ({ http: { requestJson: vi.fn() } }));
vi.mock("@/shared/lib/http", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/http")>()),
  requestJson: http.requestJson,
}));

import {
  getDocumentVersion,
  getLatestDocument,
  listConversationDocuments,
  listDocumentVersions,
} from "@/shared/lib/api";
import {
  CanvasDocumentListSchema,
  CanvasDocumentVersionSchema,
  CanvasDocumentVersionsSchema,
} from "@/shared/lib/schemas";
import { transformMessage } from "@/shared/lib/consts";
import {
  canvasDocumentHref,
  canvasDocumentPath,
  isCanvasDocumentPath,
} from "@/shared/lib/canvasDocuments";
import { ArtifactCard } from "@/features/chat/components/message_parts/ArtifactCard";
import { CanvasOpenerContext } from "@/features/chat/lib/canvasOpener";
import { findCanvasFile } from "@/features/canvas/lib/canvasFile";
import type { ArtifactBlock, MessageOut } from "@/shared/lib/types";

const VERSION = {
  path: "/conversation/output/brief.md",
  name: "brief.md",
  version: 3,
  author: "user",
  base_version: 2,
  created_at: "2026-11-18T09:40:00Z",
  size_bytes: 120,
  content: "# Brief\n\nText.\n",
};

describe("documents contract", () => {
  it("maps the list to camelCase and drops rows the canvas could not open", () => {
    const documents = CanvasDocumentListSchema.parse({
      documents: [
        {
          path: "/conversation/output/brief.md",
          name: "brief.md",
          version: 2,
          author: "agent",
          updated_at: "2026-11-18T09:40:00Z",
          size_bytes: 120,
        },
        { path: "/conversation/output/x.md", version: 0, author: "agent" },
        { name: "no-path.md", version: 1 },
        "junk",
      ],
    });
    expect(documents).toEqual([
      {
        path: "/conversation/output/brief.md",
        name: "brief.md",
        version: 2,
        author: "agent",
        updatedAt: "2026-11-18T09:40:00Z",
        sizeBytes: 120,
      },
    ]);
  });

  it("maps a version, and names it from its path when the name is missing", () => {
    const { name: _name, ...nameless } = VERSION;
    expect(CanvasDocumentVersionSchema.parse(nameless)).toEqual({
      path: "/conversation/output/brief.md",
      name: "brief.md",
      version: 3,
      author: "user",
      baseVersion: 2,
      createdAt: "2026-11-18T09:40:00Z",
      sizeBytes: 120,
      content: "# Brief\n\nText.\n",
    });
    // An unknown author never reads as the user's: it is the agent's.
    expect(CanvasDocumentVersionSchema.parse({ ...VERSION, author: "admin" }).author).toBe("agent");
  });

  it("refuses a version without its markdown or its number", () => {
    const { content: _content, ...empty } = VERSION;
    expect(CanvasDocumentVersionSchema.safeParse(empty).success).toBe(false);
    expect(CanvasDocumentVersionSchema.safeParse({ ...VERSION, version: 0 }).success).toBe(false);
    expect(CanvasDocumentVersionSchema.safeParse({ ...VERSION, path: "" }).success).toBe(false);
  });

  it("is idempotent on its own output (the production re-parse relies on it)", () => {
    const once = CanvasDocumentVersionSchema.parse(VERSION);
    expect(CanvasDocumentVersionSchema.parse(once)).toEqual(once);
  });

  it("maps the version list, newest first as sent", () => {
    const { versions } = CanvasDocumentVersionsSchema.parse({
      path: VERSION.path,
      versions: [
        { version: 2, author: "user", base_version: 1, created_at: "b", size_bytes: 9 },
        { version: 1, author: "agent", base_version: null, created_at: "a", size_bytes: 8 },
        { version: -1 },
      ],
    });
    expect(versions).toEqual([
      { version: 2, author: "user", baseVersion: 1, createdAt: "b", sizeBytes: 9 },
      { version: 1, author: "agent", baseVersion: null, createdAt: "a", sizeBytes: 8 },
    ]);
  });
});

describe("documents API", () => {
  beforeEach(() => http.requestJson.mockReset());

  const urlOf = () => http.requestJson.mock.calls.at(-1)?.[0];
  const pathQuery = "path=%2Fconversation%2Foutput%2Fbrief.md";

  it("reads the four routes, the path as a query parameter", async () => {
    http.requestJson.mockResolvedValueOnce([]);
    await listConversationDocuments("user-1", "conv 1");
    expect(urlOf()).toBe("/api/v1/conversations/user-1/conv%201/documents");

    http.requestJson.mockResolvedValueOnce(CanvasDocumentVersionSchema.parse(VERSION));
    const latest = await getLatestDocument("user-1", "conv-1", VERSION.path);
    expect(urlOf()).toBe(`/api/v1/conversations/user-1/conv-1/documents/latest?${pathQuery}`);
    expect(latest.content).toBe(VERSION.content);

    http.requestJson.mockResolvedValueOnce({ path: VERSION.path, versions: [] });
    await listDocumentVersions("user-1", "conv-1", VERSION.path);
    expect(urlOf()).toBe(`/api/v1/conversations/user-1/conv-1/documents/versions?${pathQuery}`);

    http.requestJson.mockResolvedValueOnce(CanvasDocumentVersionSchema.parse(VERSION));
    await getDocumentVersion("user-1", "conv-1", VERSION.path, 2);
    expect(urlOf()).toBe(`/api/v1/conversations/user-1/conv-1/documents/versions/2?${pathQuery}`);
  });

  it("turns a production fail-open body without markdown into an error", async () => {
    // requestJson hands back the raw body when its schema fails in production.
    const { content: _content, ...raw } = VERSION;
    http.requestJson.mockResolvedValueOnce(raw);
    await expect(getLatestDocument("user-1", "conv-1", VERSION.path)).rejects.toThrow();
  });
});

describe("attachment source path", () => {
  const withAttachment = (attachment: Record<string, unknown>) =>
    transformMessage({
      id: "m1",
      sender: "ai",
      attachments: [{ id: "a1", name: "brief.md", ...attachment }],
    }).attachments?.[0];

  it("keeps the presented path from either spelling, and nothing for an upload", () => {
    expect(withAttachment({ source_path: "/conversation/output/brief.md" })?.sourcePath).toBe(
      "/conversation/output/brief.md",
    );
    expect(withAttachment({ sourcePath: "/conversation/output/a/b.md" })?.sourcePath).toBe(
      "/conversation/output/a/b.md",
    );
    expect(withAttachment({ source_path: null })?.sourcePath).toBeUndefined();
    expect(withAttachment({})?.sourcePath).toBeUndefined();
  });
});

describe("the canvas document path rule", () => {
  it("uses the presented path, else the output folder plus the name — .md only", () => {
    expect(canvasDocumentPath({ fileName: "brief.md" })).toBe("/conversation/output/brief.md");
    expect(canvasDocumentPath({ fileName: "brief.md", sourcePath: null })).toBe(
      "/conversation/output/brief.md",
    );
    expect(
      canvasDocumentPath({
        fileName: "brief.md",
        sourcePath: "/conversation/output/drafts/brief.md",
      }),
    ).toBe("/conversation/output/drafts/brief.md");
    expect(canvasDocumentPath({ fileName: "report.pdf" })).toBeNull();
    expect(canvasDocumentPath({ fileName: "deck.pptx" })).toBeNull();
    expect(
      canvasDocumentPath({ fileName: "notes.md", sourcePath: "/conversation/input/notes.md" }),
    ).toBeNull();
  });

  it("refuses paths outside the output folder or with dot segments", () => {
    expect(isCanvasDocumentPath("/conversation/output/a.md")).toBe(true);
    expect(isCanvasDocumentPath("/conversation/output/../secrets.md")).toBe(false);
    expect(isCanvasDocumentPath("/conversation/output//a.md")).toBe(false);
    expect(isCanvasDocumentPath("/conversation/output/./a.md")).toBe(false);
    expect(isCanvasDocumentPath("/etc/a.md")).toBe(false);
    expect(isCanvasDocumentPath("/conversation/output/a.md.txt")).toBe(false);
  });

  it("builds the conversation URL with the document open", () => {
    expect(canvasDocumentHref("conv-1", "/conversation/output/brief.md")).toBe(
      "/c/conv-1?doc=%2Fconversation%2Foutput%2Fbrief.md",
    );
  });

  it("finds the presented file behind a document, for the 404 fallback preview", () => {
    const messages = [
      {
        id: "m1",
        attachments: [
          { id: "old", name: "brief.md", origin: "generated", blobId: "b0", presented: false },
          { id: "up", name: "brief.md", origin: "upload", blobId: "b1" },
        ],
      },
      {
        id: "m2",
        attachments: [
          { id: "new", name: "brief.md", origin: "generated", blobId: "b2", presented: true },
        ],
      },
    ] as unknown as MessageOut[];
    expect(findCanvasFile(messages, "/conversation/output/brief.md")?.attachment.id).toBe("new");
    expect(findCanvasFile(messages, "/conversation/output/other.md")).toBeNull();
  });
});

describe("artifact card — Open in canvas", () => {
  const message = (name: string, mime: string, extra: Record<string, unknown> = {}) =>
    ({
      id: "m1",
      attachments: [
        { id: "a1", name, mime, blobId: "b1", origin: "generated", presented: true, ...extra },
      ],
    }) as unknown as MessageOut;
  const block = (filename: string, mime: string) =>
    ({
      type: "artifact",
      filename,
      mime,
      title: "The brief",
      summary: "A plan.",
    }) as unknown as ArtifactBlock;

  it("opens a presented .md in the canvas, by the card and by its button", () => {
    const open = vi.fn();
    render(
      <CanvasOpenerContext.Provider value={open}>
        <ArtifactCard
          block={block("brief.md", "text/markdown")}
          message={message("brief.md", "text/markdown", {
            sourcePath: "/conversation/output/x/brief.md",
          })}
          onDownload={vi.fn()}
        />
      </CanvasOpenerContext.Provider>,
    );
    expect(screen.getByText("Open in canvas")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Open The brief in canvas" }));
    expect(open).toHaveBeenLastCalledWith(
      "/conversation/output/x/brief.md",
      expect.any(HTMLElement),
    );
    fireEvent.click(screen.getByText("A plan."));
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("offers no canvas for a PDF, nor where the chat has no canvas (a share)", () => {
    const open = vi.fn();
    const { unmount } = render(
      <CanvasOpenerContext.Provider value={open}>
        <ArtifactCard
          block={block("r.pdf", "application/pdf")}
          message={message("r.pdf", "application/pdf")}
        />
      </CanvasOpenerContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: /in canvas/ })).not.toBeInTheDocument();
    unmount();

    render(
      <ArtifactCard
        block={block("brief.md", "text/markdown")}
        message={message("brief.md", "text/markdown")}
      />,
    );
    expect(screen.queryByText("Open in canvas")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /in canvas/ })).not.toBeInTheDocument();
  });
});
