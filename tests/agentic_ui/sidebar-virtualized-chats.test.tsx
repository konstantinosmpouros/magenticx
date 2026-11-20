// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatSidebar from "@/features/chat/components/ChatSidebar";
import type { Agent, ConversationSummary } from "@/shared/lib/types";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";

/**
 * The sidebar's Chats section with hundreds of chats (plan 45, Phase 6).
 *
 * Above sixty chats the list is virtualized: the DOM holds a bounded window of
 * rows, not one per chat. Rows still rename in place and run their menus, a
 * row warms its conversation on hover and focus (`onPrefetchConversation`),
 * and keyboard focus survives the list switching form as it crosses the line.
 * happy-dom lays nothing out, so the window here is the hook's fallback (about
 * a screen of 32px rows plus overscan).
 */

const conversation = (index: number): ConversationSummary => ({
  id: `c${index}`,
  agent: { id: "a1", name: "Agent" } as Agent,
  title: `Chat ${index}`,
  isPrivate: false,
  created_at: "2026-10-01T10:00:00Z",
  updated_at: "2026-10-01T10:00:00Z",
});

const many = (count: number) => Array.from({ length: count }, (_, index) => conversation(index));

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

const chatsList = () => {
  const heading = screen.getByRole("button", { name: "Chats" });
  return document.getElementById(heading.getAttribute("aria-controls")!)!;
};
const chatRows = () => chatsList().querySelectorAll("[data-conversation-id]");
/** A row's main button, inside the Chats list (a focused row's tooltip repeats its title). */
const rowButton = (title: string) =>
  [...chatsList().querySelectorAll<HTMLElement>('[data-sidebar="menu-button"]')].find(
    (button) => button.textContent === title,
  )!;

beforeEach(() => {
  localStorage.clear();
});

describe("sidebar Chats with many conversations", () => {
  it("keeps a bounded number of rows in the DOM", () => {
    render(sidebar({ conversations: many(300) }));

    expect(chatsList().querySelector('[data-virtualized="true"]')).not.toBeNull();
    const rows = chatRows();
    expect(rows.length).toBeGreaterThan(10);
    expect(rows.length).toBeLessThan(60);
    expect(screen.getByText("Chat 0")).toBeInTheDocument();
    expect(screen.queryByText("Chat 299")).toBeNull();
  });

  it("renders every row, animated, up to the threshold", () => {
    render(sidebar({ conversations: many(60) }));

    expect(chatsList().querySelector('[data-virtualized="true"]')).toBeNull();
    expect(chatRows()).toHaveLength(60);
    expect(chatsList().querySelectorAll('[data-motion="row"]')).toHaveLength(60);
  });

  it("brings later rows in as the list scrolls", () => {
    render(sidebar({ conversations: many(300) }));
    const list = chatsList();

    // happy-dom has no layout, so it keeps scrollTop at 0: report the offset.
    Object.defineProperty(list, "scrollTop", { configurable: true, value: 200 * 32 });
    act(() => {
      fireEvent.scroll(list);
    });

    expect(screen.getByText("Chat 200")).toBeInTheDocument();
    expect(screen.queryByText("Chat 0")).toBeNull();
    expect(chatRows().length).toBeLessThan(60);
  });

  it("renames a row of the virtualized list in place", () => {
    const onRename = vi.fn();
    render(sidebar({ conversations: many(300), onRenameConversation: onRename }));

    fireEvent.contextMenu(rowButton("Chat 3"));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename" }));
    const field = screen.getByPlaceholderText("Rename conversation");
    expect(field).toHaveProperty("value", "Chat 3");

    fireEvent.change(field, { target: { value: "Budget review" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onRename).toHaveBeenCalledWith("c3", "Budget review");
  });

  it("warms a conversation when its row is hovered or focused", () => {
    const onPrefetch = vi.fn();
    render(sidebar({ conversations: many(300), onPrefetchConversation: onPrefetch }));

    fireEvent.pointerEnter(rowButton("Chat 2").closest("li")!);
    expect(onPrefetch).toHaveBeenLastCalledWith("c2");

    fireEvent.focus(rowButton("Chat 4"));
    expect(onPrefetch).toHaveBeenLastCalledWith("c4");
  });

  it("warms on hover in a short, animated list too", () => {
    const onPrefetch = vi.fn();
    render(sidebar({ conversations: many(3), onPrefetchConversation: onPrefetch }));

    fireEvent.pointerEnter(rowButton("Chat 1").closest("li")!);
    expect(onPrefetch).toHaveBeenCalledWith("c1");
  });

  it("keeps keyboard focus on its row when the list becomes virtualized", () => {
    const props: Partial<SidebarProps> = { conversations: many(60) };
    const { rerender } = render(sidebar(props));
    rowButton("Chat 5").focus();
    expect(document.activeElement).toBe(rowButton("Chat 5"));

    // One more page lands: the list crosses the threshold and every row remounts.
    act(() => {
      rerender(sidebar({ ...props, conversations: many(70) }));
    });

    expect(chatsList().querySelector('[data-virtualized="true"]')).not.toBeNull();
    expect(document.activeElement).toBe(rowButton("Chat 5"));
  });
});
