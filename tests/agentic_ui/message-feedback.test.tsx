// @vitest-environment happy-dom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AIActionBar } from "@/features/chat/components/message_parts/ActionBars";
import type { MessageOut } from "@/shared/lib/types";
import { TooltipProvider } from "@/shared/ui/tooltip";

/** One Feedback button per answer, with a Good response / Bad response menu. */

const answer = (liked?: boolean | null) =>
  ({ id: "m1", sender: "ai", content: "Hi", created_at: new Date(0), liked }) as MessageOut;

const renderBar = (message: MessageOut, readOnly = false) => {
  const onLike = vi.fn();
  const onDislike = vi.fn();
  render(
    <TooltipProvider>
      <AIActionBar
        message={message}
        copiedId={null}
        onCopy={() => {}}
        onLike={onLike}
        onDislike={onDislike}
        readOnly={readOnly}
      />
    </TooltipProvider>,
  );
  return { onLike, onDislike };
};

const openFeedback = async (name: RegExp = /^Feedback/) => {
  fireEvent.keyDown(screen.getByRole("button", { name }), { key: "Enter" });
  return screen.findByRole("menu");
};

describe("the Feedback button", () => {
  it("replaces the separate Like and Dislike buttons", () => {
    renderBar(answer());
    expect(screen.getByRole("button", { name: "Feedback" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Like" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Dislike" })).toBeNull();
  });

  it("rates the answer good or bad from its menu", async () => {
    const { onLike, onDislike } = renderBar(answer());
    fireEvent.click(within(await openFeedback()).getByRole("menuitemcheckbox", { name: "Good response" }));
    expect(onLike).toHaveBeenCalledTimes(1);

    fireEvent.click(within(await openFeedback()).getByRole("menuitemcheckbox", { name: "Bad response" }));
    expect(onDislike).toHaveBeenCalledTimes(1);
  });

  it("shows the current rating, checked, and clears it when picked again", async () => {
    const { onDislike } = renderBar(answer(false));
    const menu = await openFeedback(/bad response/);
    const bad = within(menu).getByRole("menuitemcheckbox", { name: "Bad response" });

    expect(bad.getAttribute("aria-checked")).toBe("true");
    expect(within(menu).getByRole("menuitemcheckbox", { name: "Good response" }).getAttribute("aria-checked")).toBe(
      "false",
    );
    fireEvent.click(bad);
    expect(onDislike).toHaveBeenCalledTimes(1); // the handler toggles it off
  });

  it("is absent on a read-only conversation", () => {
    renderBar(answer(), true);
    expect(screen.queryByRole("button", { name: /^Feedback/ })).toBeNull();
  });
});
