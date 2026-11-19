// @vitest-environment happy-dom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import ChatSidebar from "@/features/chat/components/ChatSidebar";
import type { Agent, ConversationSummary } from "@/shared/lib/types";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";

/**
 * The right-click menu on a sidebar conversation row.
 *
 * It offers the row's "⋯" actions at the pointer (one shared item list, so the
 * two never drift), is off while the chat is busy or being renamed, ignores a
 * finger's long-press (tap-through, see `ContextMenuTrigger`), reports itself
 * as open floating UI, and closes when the shell asks the sidebar to dismiss.
 */

const conversation = (
  id: string,
  title: string,
  extra: Partial<ConversationSummary> = {},
): ConversationSummary => ({
  id,
  agent: { id: "a1", name: "Agent" } as Agent,
  title,
  isPrivate: false,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
  ...extra,
});

const interaction = () => ({
  isLogoHovered: false,
  handleSidebarMouseEnter: () => {},
  handleSidebarMouseLeave: () => {},
  toggleCollapsedOnBlankArea: () => {},
});

type SidebarProps = React.ComponentProps<typeof ChatSidebar>;

function sidebar(props: Partial<SidebarProps> = {}) {
  return (
    <TooltipProvider>
      <SidebarProvider defaultOpen>
        <ChatSidebar
          conversations={[]}
          currentConversationId={null}
          onSelectConversation={() => {}}
          onDeleteConversation={() => {}}
          onLoadMore={() => {}}
          isLoadingMore={false}
          isInitialLoading={false}
          hasMore={false}
          onTitleClick={() => {}}
          onNewChat={() => {}}
          onOpenSearch={() => {}}
          onOpenSettings={() => {}}
          onEditProfile={() => {}}
          onOpenShortcuts={() => {}}
          onOpenHelp={() => {}}
          onLogout={() => {}}
          userProfile={null}
          sidebarInteractionHook={interaction}
          {...props}
        />
      </SidebarProvider>
    </TooltipProvider>
  );
}

/** The row's main button, found by its title. */
const row = (title: string) => screen.getByText(title).closest("button")!;

describe("sidebar conversation right-click menu", () => {
  it("offers the row's actions at the pointer and runs the picked one", () => {
    const onDelete = vi.fn();
    const onArchive = vi.fn();
    const onFloating = vi.fn();
    render(
      sidebar({
        conversations: [conversation("c1", "Budget review")],
        onDeleteConversation: onDelete,
        onArchiveConversation: onArchive,
        onFloatingUiStateChange: onFloating,
      }),
    );

    fireEvent.contextMenu(row("Budget review"), { clientX: 40, clientY: 80 });

    const menu = screen.getByRole("menu", { name: "Actions for Budget review" });
    const labels = within(menu)
      .getAllByRole("menuitem")
      .map((item) => item.textContent);
    expect(labels).toEqual(["Rename", "Pin", "Archive", "Report", "Delete"]);
    expect(onFloating).toHaveBeenLastCalledWith(true);

    fireEvent.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    expect(onDelete).toHaveBeenCalledWith("c1");
    expect(onArchive).not.toHaveBeenCalled();
  });

  it("reads Unpin on a pinned chat and toggles it", () => {
    const onTogglePin = vi.fn();
    const pinned = conversation("c1", "Pinned chat", {
      isPinned: true,
      pinnedAt: new Date("2026-10-02T10:00:00Z"),
    });
    render(sidebar({ conversations: [pinned], onTogglePinConversation: onTogglePin }));

    fireEvent.contextMenu(row("Pinned chat"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unpin" }));

    expect(onTogglePin).toHaveBeenCalledWith(pinned);
  });

  it("opens no menu on a chat that is still streaming", () => {
    render(sidebar({ conversations: [conversation("c1", "Live run", { isStreaming: true })] }));

    fireEvent.contextMenu(row("Live run"));

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("ignores a finger's long-press", () => {
    render(sidebar({ conversations: [conversation("c1", "Touch chat")] }));
    const target = row("Touch chat");

    // Android fires `contextmenu` for a long-press while the finger is down.
    fireEvent.pointerDown(target, { pointerType: "touch" });
    fireEvent.contextMenu(target);
    fireEvent.pointerUp(target, { pointerType: "touch" });

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("starts renaming the row from the menu", () => {
    render(
      sidebar({
        conversations: [conversation("c1", "Old title")],
        onRenameConversation: () => {},
      }),
    );

    fireEvent.contextMenu(row("Old title"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));

    expect(screen.getByPlaceholderText("Rename conversation")).toHaveProperty("value", "Old title");
  });

  it("closes when the shell dismisses the sidebar's floating UI", () => {
    const onFloating = vi.fn();
    const props: Partial<SidebarProps> = {
      conversations: [conversation("c1", "Some chat")],
      onFloatingUiStateChange: onFloating,
      dismissFloatingUiSignal: 0,
    };
    const { rerender } = render(sidebar(props));

    fireEvent.contextMenu(row("Some chat"));
    expect(screen.getByRole("menu")).toBeTruthy();

    act(() => {
      rerender(sidebar({ ...props, dismissFloatingUiSignal: 1 }));
    });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(onFloating).toHaveBeenLastCalledWith(false);
  });
});
