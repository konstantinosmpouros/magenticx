import { useCallback, useEffect, useState } from "react";

import { searchWorkspace } from "@/shared/lib/api";
import type { Agent, ConversationSummary, WorkspaceSearchResult } from "@/shared/lib/types";

const resolveConversationSummaryTitle = (conversation: ConversationSummary) => {
  const rawTitle = typeof conversation.title === "string" ? conversation.title.trim() : "";
  if (rawTitle) return rawTitle;
  const lastMessage = (conversation.lastMessage ?? "").trim();
  if (lastMessage) return lastMessage;
  return conversation.agent?.name || "Untitled chat";
};

type WorkspaceSearchCtx = {
  userId: string | null;
  onOpen?: () => void;
};

export function useWorkspaceSearch({ userId, onOpen }: WorkspaceSearchCtx) {
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<WorkspaceSearchResult[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const openSearchPanel = useCallback(() => {
    onOpen?.();
    setIsSearchOpen(true);
  }, [onOpen]);

  const closeSearchPanel = useCallback(() => {
    setIsSearchOpen(false);
  }, []);

  useEffect(() => {
    if (!isSearchOpen) return;

    const query = searchQuery.trim();
    if (!userId || query.length === 0) {
      setSearchResults([]);
      setSearchLoading(false);
      setSearchError(null);
      return;
    }

    // A newer keystroke (or closing the panel) aborts the request in flight
    // rather than only ignoring its answer (plan 45): the browser drops the
    // connection, and the bridge stops paying for a search no one will read.
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(null);
    const timeout = window.setTimeout(() => {
      searchWorkspace(userId, query, 20, controller.signal)
        .then((results) => {
          if (controller.signal.aborted) return;
          setSearchResults(results);
        })
        .catch((error) => {
          if (controller.signal.aborted) return;
          console.error("Failed to search workspace:", error);
          setSearchResults([]);
          setSearchError("Search failed. Please try again.");
        })
        .finally(() => {
          if (!controller.signal.aborted) setSearchLoading(false);
        });
    }, 250);

    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [isSearchOpen, searchQuery, userId]);

  return {
    isSearchOpen,
    searchQuery,
    setSearchQuery,
    searchResults,
    searchLoading,
    searchError,
    openSearchPanel,
    closeSearchPanel,
  };
}

type SearchResultHandlersCtx = {
  agents: Agent[];
  onAgentSelect: (agentId: string) => void;
  onConversationSelect: (conversation: ConversationSummary) => void;
  onCloseSearch: () => void;
};

export function createSearchResultHandlers({
  agents,
  onAgentSelect,
  onConversationSelect,
  onCloseSearch,
}: SearchResultHandlersCtx) {
  const handleSearchResultSelect = (result: WorkspaceSearchResult) => {
    onCloseSearch();
    if (result.kind === "agent") {
      if (result.agentId) {
        onAgentSelect(result.agentId);
      }
      return;
    }

    const conversationId = result.conversationId;
    if (!conversationId) return;
    const agent =
      agents.find((item) => item.id === result.agentId) ??
      agents.find((item) => item.isActive) ??
      agents[0];
    if (!agent) return;

    const timestamp =
      typeof result.updatedAt === "string" || result.updatedAt instanceof Date
        ? result.updatedAt
        : new Date().toISOString();

    onConversationSelect({
      id: conversationId,
      agent,
      title: result.title,
      // Safe to hardcode: workspace search filters `is_private == False` at the
      // query level (dialogue_bridge/utils/search.py), so a private conversation
      // can never surface as a search result in the first place.
      isPrivate: false,
      isArchived: false,
      lastMessage: result.snippet || undefined,
      created_at: String(timestamp),
      updated_at: String(timestamp),
    });
  };

  return { handleSearchResultSelect };
}

export function buildDefaultConversationSearchResults(
  conversations: ConversationSummary[],
  limit: number = 6,
): WorkspaceSearchResult[] {
  return conversations.slice(0, limit).map((conversation) => ({
    kind: "conversation",
    id: conversation.id,
    conversationId: conversation.id,
    agentId: conversation.agent?.id,
    title: resolveConversationSummaryTitle(conversation),
    subtitle: conversation.agent?.name,
    snippet: conversation.lastMessage,
    updatedAt: conversation.updated_at,
  }));
}
