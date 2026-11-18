// @vitest-environment happy-dom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SidePanel } from "@/features/agents/components/builder/SidePanel";

/**
 * The agent builder's side panel (YAML, Import, Try it) is not modal, so the
 * page stays usable beside it, but a press anywhere outside it closes it.
 * Focus leaving on its own (a file picker closing) and a press on a toast do not.
 */
async function renderPanel() {
  const onOpenChange = vi.fn();
  render(
    <div>
      <button type="button">Canvas node</button>
      <div data-sonner-toaster="">
        <button type="button">Toast action</button>
      </div>
      <SidePanel open onOpenChange={onOpenChange} title="agent.yaml">
        <p>body</p>
      </SidePanel>
    </div>,
  );
  // Radix registers its outside-press listener on the next tick.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return onOpenChange;
}

describe("the agent builder's side panel", () => {
  it("closes on a press outside it", async () => {
    const onOpenChange = await renderPanel();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Canvas node" }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("stays open when only the focus moves away", async () => {
    const onOpenChange = await renderPanel();
    act(() => screen.getByRole("button", { name: "Canvas node" }).focus());
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("stays open on a press inside it or on a toast", async () => {
    const onOpenChange = await renderPanel();
    fireEvent.pointerDown(screen.getByText("body"));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Toast action" }));
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
