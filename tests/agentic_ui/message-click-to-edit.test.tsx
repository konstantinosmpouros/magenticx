// @vitest-environment happy-dom
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ChatMessage } from "@/features/chat/components/ChatMessage";
import { TooltipProvider } from "@/shared/ui/tooltip";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

const api = vi.hoisted(() => ({ transcribeDictation: vi.fn() }));
vi.mock("@/shared/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/shared/lib/api")>()),
  ...api,
}));

/**
 * A click on the user's own bubble opens it for editing (as in Cursor), and
 * the bubble turns into a small editor: Enter sends, Esc cancels, an empty
 * draft cannot be sent. A click that was really a text selection does not open it.
 */

type Props = React.ComponentProps<typeof ChatMessage>;

const Icon = () => null;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
);
const message = {
  id: "m1",
  sender: "user",
  content: "Hello there",
  created_at: new Date(0),
  attachments: [],
};

const props = (overrides: Record<string, unknown> = {}) =>
  ({
    message,
    isEditing: false,
    AgentIcon: Icon,
    copiedId: null,
    onCopy: vi.fn(),
    onLike: vi.fn(),
    onDislike: vi.fn(),
    onFlashUserActionBar: vi.fn(),
    onRequestEdit: vi.fn(),
    userActionVisibilityClass: "",
    expandedThinking: {},
    onToggleThinking: vi.fn(),
    isImageFile: () => false,
    onDownloadAttachment: vi.fn(),
    onPreviewAttachment: vi.fn(),
    onImageClick: vi.fn(),
    branchData: { parentId: null, options: undefined, selectionIndex: 0, onSelectBranch: undefined },
    ...overrides,
  }) as unknown as Props;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("click a user message to edit it", () => {
  it("opens the editor on a click in the bubble", () => {
    const p = props();
    render(<ChatMessage {...p} />, { wrapper });
    const bubbles = screen.getAllByRole("button", { name: "Edit message" });
    // The bubble itself, plus the bar's pencil.
    const bubble = bubbles.find((el) => el.tagName === "DIV");
    expect(bubble).toBeDefined();
    fireEvent.click(bubble!);
    expect(p.onRequestEdit).toHaveBeenCalledWith(message);
  });

  it("opens it from the keyboard too", () => {
    const p = props();
    render(<ChatMessage {...p} />, { wrapper });
    const bubble = screen.getAllByRole("button", { name: "Edit message" }).find((el) => el.tagName === "DIV")!;
    fireEvent.keyDown(bubble, { key: "Enter" });
    expect(p.onRequestEdit).toHaveBeenCalledTimes(1);
  });

  it("leaves a text selection alone", () => {
    vi.spyOn(window, "getSelection").mockReturnValue({ toString: () => "Hello" } as Selection);
    const p = props();
    render(<ChatMessage {...p} />, { wrapper });
    const bubble = screen.getAllByRole("button", { name: "Edit message" }).find((el) => el.tagName === "DIV")!;
    fireEvent.click(bubble);
    expect(p.onRequestEdit).not.toHaveBeenCalled();
  });

  it("is not clickable in a read-only view", () => {
    render(<ChatMessage {...props({ readOnly: true })} />, { wrapper });
    expect(screen.queryAllByRole("button", { name: "Edit message" })).toHaveLength(0);
  });
});

describe("the editor", () => {
  it("sends on Enter and cancels on Esc", () => {
    const p = props({ isEditing: true, editingDraft: "Hello again", onSubmitEdit: vi.fn(), onCancelEdit: vi.fn() });
    render(<ChatMessage {...p} />, { wrapper });
    const box = screen.getByRole("textbox", { name: "Edit your message" });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(p.onSubmitEdit).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: "Escape" });
    expect(p.onCancelEdit).toHaveBeenCalledTimes(1);
  });

  it("shows the message's files in the editor, and takes one out", () => {
    const withFile = {
      ...message,
      attachments: [{ id: "a1", name: "notes.txt", mime: "text/plain", timestamp: new Date(0) }],
    };
    const onChangeEditAttachments = vi.fn();
    render(
      <ChatMessage
        {...props({
          message: withFile,
          isEditing: true,
          editingDraft: "Hello",
          editingAttachments: { keptIds: ["a1"], files: [] },
          onChangeEditAttachments,
        })}
      />,
      { wrapper },
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove notes.txt" }));
    expect(onChangeEditAttachments).toHaveBeenCalledWith({ keptIds: [], files: [] });
  });

  it("adds files with the plus button, after the ones it keeps", () => {
    const onChangeEditAttachments = vi.fn();
    const { container } = render(
      <ChatMessage
        {...props({
          isEditing: true,
          editingDraft: "Hello",
          editingAttachments: { keptIds: ["a1"], files: [] },
          onChangeEditAttachments,
        })}
      />,
      { wrapper },
    );
    expect(screen.getByRole("button", { name: "Attach files" })).toBeEnabled();
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(["x"], "plan.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [file] } });
    expect(onChangeEditAttachments).toHaveBeenCalledWith({ keptIds: ["a1"], files: [file] });
    // The keyboard hint line is gone; the keys still work.
    expect(screen.queryByText(/to send/)).toBeNull();
  });

  it("cancels on a press outside the editor, not inside it, and has no Cancel button", () => {
    const p = props({ isEditing: true, editingDraft: "Hello again", onCancelEdit: vi.fn() });
    render(<ChatMessage {...p} />, { wrapper });
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

    fireEvent.pointerDown(screen.getByRole("textbox", { name: "Edit your message" }));
    expect(p.onCancelEdit).not.toHaveBeenCalled();
    fireEvent.pointerDown(document.body);
    expect(p.onCancelEdit).toHaveBeenCalledTimes(1);
  });

  it("dictates into the draft: the transcript is appended", async () => {
    // A recorder that hands over one chunk when stopped.
    class FakeRecorder {
      state = "inactive";
      mimeType = "audio/webm";
      ondataavailable: ((event: { data: Blob }) => void) | null = null;
      onstop: (() => void) | null = null;
      start() {
        this.state = "recording";
      }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new Blob(["voice"], { type: "audio/webm" }) });
        this.onstop?.();
      }
    }
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [] })) },
    });
    useWorkspaceStore.setState({ userId: "u1" });
    api.transcribeDictation.mockResolvedValue("  and more  ");
    const p = props({ isEditing: true, editingDraft: "Hello", onChangeEditDraft: vi.fn() });
    render(<ChatMessage {...p} />, { wrapper });

    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Dictate" })));
    await act(async () => fireEvent.click(await screen.findByRole("button", { name: "Stop dictation" })));

    await waitFor(() => expect(p.onChangeEditDraft).toHaveBeenCalledWith("Hello and more"));
    expect(api.transcribeDictation).toHaveBeenCalledWith("u1", expect.any(Blob), expect.stringMatching(/\.webm$/));
    vi.unstubAllGlobals();
  });

  it("cannot send an empty draft", () => {
    render(<ChatMessage {...props({ isEditing: true, editingDraft: "   " })} />, { wrapper });
    expect(screen.getByRole("button", { name: "Send the edited message" })).toBeDisabled();
  });
});
