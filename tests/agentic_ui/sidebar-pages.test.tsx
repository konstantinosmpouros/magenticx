// @vitest-environment happy-dom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ChatSidebar from "@/features/chat/components/ChatSidebar";
import { SidebarProvider } from "@/shared/ui/sidebar";
import { TooltipProvider } from "@/shared/ui/tooltip";

/**
 * The sidebar's page entries (plan 44): Search, Automations, Agents and
 * Artifacts. Voice mode left the sidebar — it still starts from the composer
 * button and its shortcut — and Artifacts joined, behaving like Agents: it
 * opens its page and is marked current while that page is open.
 */

const interaction = () => ({
  isLogoHovered: false,
  handleSidebarMouseEnter: () => {},
  handleSidebarMouseLeave: () => {},
  toggleCollapsedOnBlankArea: () => {},
});

function renderSidebar(props: Partial<React.ComponentProps<typeof ChatSidebar>> = {}) {
  return render(
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
    </TooltipProvider>,
  );
}

const entry = (name: string) => screen.getByRole("button", { name });

beforeEach(() => {
  localStorage.clear();
});

describe("sidebar page entries", () => {
  it("has no Voice mode entry", () => {
    renderSidebar();
    expect(screen.queryByRole("button", { name: /voice mode/i })).toBeNull();
    expect(screen.queryByText("Voice mode")).toBeNull();
  });

  it("lists Search, Artifacts, Automations and Agents, in that order", () => {
    renderSidebar();
    const names = ["Search", "Artifacts", "Automations", "Agents"].map(entry);
    for (let i = 1; i < names.length; i += 1) {
      // DOCUMENT_POSITION_FOLLOWING: each entry comes after the one before it.
      expect(names[i - 1].compareDocumentPosition(names[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it("opens the Artifacts page", () => {
    const onOpenArtifacts = vi.fn();
    renderSidebar({ onOpenArtifacts });
    fireEvent.click(entry("Artifacts"));
    expect(onOpenArtifacts).toHaveBeenCalledTimes(1);
  });

  it("marks Artifacts current while its page is open, and only then", () => {
    const { unmount } = renderSidebar({ activePage: "artifacts" });
    expect(entry("Artifacts")).toHaveAttribute("aria-current", "page");
    expect(entry("Agents")).not.toHaveAttribute("aria-current");
    unmount();

    renderSidebar({ activePage: "agents" });
    expect(entry("Artifacts")).not.toHaveAttribute("aria-current");
    expect(entry("Agents")).toHaveAttribute("aria-current", "page");
  });
});
