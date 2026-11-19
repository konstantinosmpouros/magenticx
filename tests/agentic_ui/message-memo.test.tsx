// @vitest-environment happy-dom
import type React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, renderHook } from "@testing-library/react";

import { useStableHandlers } from "@/shared/hooks/useStableHandlers";
import { TooltipProvider } from "@/shared/ui/tooltip";

/**
 * Plan 45, Phase 3: a settled message must not re-render while another answer
 * streams. ChatMessage is memoized, with the branch switchers compared field
 * by field (the list rebuilds them per row on every render), and ChatBody hands
 * it stable callbacks through useStableHandlers.
 */

const content = vi.hoisted(() => ({ renders: 0 }));
vi.mock("@/features/chat/components/message_parts/Content", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    MessageContent: () => {
      content.renders += 1;
      return null;
    },
  };
});

const { ChatMessage } = await import("@/features/chat/components/ChatMessage");
type Props = React.ComponentProps<typeof ChatMessage>;

const Icon = () => null;
const wrapper = ({ children }: { children: React.ReactNode }) => (
  <TooltipProvider>{children}</TooltipProvider>
);
const message = {
  id: "m1",
  sender: "user",
  content: "Hello",
  created_at: new Date(0),
  attachments: [],
};

const props = () => ({
  message,
  isEditing: false,
  AgentIcon: Icon as never,
  copiedId: null,
  onCopy: vi.fn(),
  onLike: vi.fn(),
  onDislike: vi.fn(),
  onFlashUserActionBar: vi.fn(),
  userActionVisibilityClass: "",
  expandedThinking: {},
  onToggleThinking: vi.fn(),
  isImageFile: () => false,
  onDownloadAttachment: vi.fn(),
  onPreviewAttachment: vi.fn(),
  onImageClick: vi.fn(),
  branchData: {
    parentId: null,
    options: undefined,
    selectionIndex: 0,
    onSelectBranch: undefined,
  },
});

afterEach(() => {
  cleanup();
  content.renders = 0;
});

describe("ChatMessage memo", () => {
  it("skips a render when only a fresh but equal branch switcher is passed", () => {
    const stable = props();
    const view = render(<ChatMessage {...(stable as unknown as Props)} />, { wrapper });
    expect(content.renders).toBe(1);
    view.rerender(
      <ChatMessage
        {...({ ...stable, branchData: { ...stable.branchData } } as unknown as Props)}
      />,
    );
    expect(content.renders).toBe(1);
  });

  it("renders again when something it shows changes", () => {
    const stable = props();
    const view = render(<ChatMessage {...(stable as unknown as Props)} />, { wrapper });
    view.rerender(
      <ChatMessage
        {...({
          ...stable,
          branchData: { ...stable.branchData, selectionIndex: 1 },
        } as unknown as Props)}
      />,
    );
    expect(content.renders).toBe(2);
    view.rerender(
      <ChatMessage
        {...({ ...stable, message: { ...message, content: "Hi" } } as unknown as Props)}
      />,
    );
    expect(content.renders).toBe(3);
  });
});

describe("useStableHandlers", () => {
  it("keeps one identity per handler and always calls the latest one", () => {
    const first = vi.fn();
    const second = vi.fn();
    const { result, rerender } = renderHook(({ onPick }) => useStableHandlers({ onPick }), {
      initialProps: { onPick: first as (() => void) | undefined },
    });
    const initial = result.current.onPick;
    rerender({ onPick: second });
    expect(result.current.onPick).toBe(initial);
    result.current.onPick?.();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("keeps a missing handler missing, so a control that needs it stays hidden", () => {
    const { result, rerender } = renderHook(({ onPick }) => useStableHandlers({ onPick }), {
      initialProps: { onPick: undefined as (() => void) | undefined },
    });
    expect(result.current.onPick).toBeUndefined();
    rerender({ onPick: vi.fn() });
    expect(result.current.onPick).toBeTypeOf("function");
  });
});
