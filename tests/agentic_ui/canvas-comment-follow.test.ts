/**
 * A comment follows its passage when the passage is rewritten (plan 44, v2):
 * the agent answering a thread (or the user) rewrites the quoted words, and
 * the thread stays on the text now between the same surroundings instead of
 * going "detached". It detaches only when the surroundings are gone too.
 */
import { describe, expect, it } from "vitest";

import { locateAnchor } from "@/features/canvas/lib/commentAnchors";

const BEFORE =
  "Brief: Agent Self-Improvement\nScope: Targeted arXiv review through 17 November 2026. I read the full text of two papers.\nBottom line\nToday, agents improve by changing parts of their setup.";
const ANCHOR = {
  quote: "Scope: Targeted arXiv review through 17 November 2026. I read the full text of two papers.",
  prefix: "Brief: Agent Self-Improvement\n",
  suffix: "\nBottom line\nToday, agents improve by changing parts of their setup.",
};

const spanOf = (text: string, placement: ReturnType<typeof locateAnchor>) =>
  placement ? text.slice(placement.start, placement.end) : null;

describe("a comment on a rewritten passage", () => {
  it("still finds the quote itself while it is there", () => {
    expect(spanOf(BEFORE, locateAnchor(BEFORE, ANCHOR))).toBe(ANCHOR.quote);
  });

  it("follows the rewrite: the text between the same surroundings", () => {
    const after = BEFORE.replace(
      ANCHOR.quote,
      "Scope: what this brief covers, what was read, and that the findings are preliminary.",
    );
    expect(spanOf(after, locateAnchor(after, ANCHOR))).toBe(
      "Scope: what this brief covers, what was read, and that the findings are preliminary.",
    );
  });

  it("still follows when the text right next to it changed a little", () => {
    const after = BEFORE.replace(ANCHOR.quote, "Scope: a shorter note.").replace(
      "Bottom line\nToday, agents improve",
      "Bottom line\nToday, LLM agents improve",
    );
    expect(spanOf(after, locateAnchor(after, ANCHOR))).toBe("Scope: a shorter note.");
  });

  it("works at the edges of the document", () => {
    const atStart = { quote: "Old title", prefix: "", suffix: "\nScope: Targeted arXiv review" };
    const text = "New title\nScope: Targeted arXiv review through 17 November 2026.";
    expect(spanOf(text, locateAnchor(text, atStart))).toBe("New title");
  });

  it("detaches when the surroundings are gone too, or there were none", () => {
    expect(locateAnchor("Something else entirely.", ANCHOR)).toBeNull();
    expect(locateAnchor(BEFORE, { quote: "Gone", prefix: "", suffix: "" })).toBeNull();
  });

  it("does not stretch over half the document to reach the suffix", () => {
    const far = `${ANCHOR.prefix}Short.\n${"x".repeat(2000)}${ANCHOR.suffix}`;
    expect(locateAnchor(far, { ...ANCHOR, quote: "Short quote" })).toBeNull();
  });
});
