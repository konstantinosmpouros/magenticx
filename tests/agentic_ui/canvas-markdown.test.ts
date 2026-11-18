/**
 * The canvas markdown round trip (plan 44, Phase 4.0): a document the agent
 * wrote must come back out of the editor as the same markdown, so a version
 * the user saves diffs cleanly against the agent's.
 *
 * Pins what must survive fixture → Plate value → markdown: headings, bullet
 * lists with bold lead-ins, numbered lists, the table, the link, inline code,
 * Greek text — and that raw HTML stays text. The known, accepted rewrites
 * (table delimiter row, `_` escaped in table cells) are pinned too, so a Plate
 * upgrade that changes them is a deliberate decision.
 */
import { describe, expect, it } from "vitest";

import { markdownToValue, valueToMarkdown } from "@/features/canvas/lib/markdown";
import { getHiddenBlocks, getOutline } from "@/features/canvas/lib/outline";

import brief from "./fixtures/canvas/brief.md?raw";

const roundTrip = (markdown: string) => valueToMarkdown(markdownToValue(markdown));
const lines = (markdown: string) => markdown.trimEnd().split("\n");

describe("canvas markdown round trip — the brief fixture", () => {
  const out = roundTrip(brief);

  it("keeps every heading, with its level and numbering", () => {
    for (const heading of [
      "# Σχέδιο έργου: Canvas documents for mAgenticX",
      "## 1. Στόχοι — Goals",
      "## 2. Εύρος — Scope",
      "## 3. Επόμενα βήματα — Next steps",
    ]) {
      expect(lines(out)).toContain(heading);
    }
  });

  it("keeps bullet items with their bold lead-ins and the `-` marker", () => {
    expect(lines(out)).toContain(
      "- **Two writers, one document.** The agent and the user both write versions, and neither silently overwrites the other.",
    );
    expect(lines(out)).toContain(
      "- **Σχόλια πάνω στο κείμενο.** Ο χρήστης σχολιάζει ένα απόσπασμα και ο πράκτορας το βλέπει στην επόμενη απάντησή του.",
    );
    expect(lines(out)).toContain("- **Owner:** Κώστας, with the agent drafting each section.");
  });

  it("keeps numbered items in order", () => {
    expect(lines(out)).toContain("1. Versions with optimistic concurrency and a conflict dialog.");
    expect(lines(out)).toContain("2. Comments anchored to a passage of text.");
    expect(lines(out)).toContain("3. Suggestions the user can accept or reject one by one.");
  });

  it("keeps the link, inline code, emphasis and the quote", () => {
    expect(out).toContain(
      "[plan 44 overview](https://github.com/EXARTeo/magenticx/blob/main/plans/44-documents-canvas-artifacts.md)",
    );
    expect(out).toContain("through `pandoc` in the sandbox");
    expect(out).toContain("`/conversation/output/`");
    expect(out).toContain("*The editor choice is final*");
    expect(lines(out)).toContain("> Comments are never part of a public share snapshot.");
  });

  it("keeps the table's rows and Greek cells (delimiter row and `_` escapes are rewritten)", () => {
    const table = lines(out).filter((line) => line.startsWith("|"));
    expect(table).toEqual([
      "| Feature | Owner | Κατάσταση |",
      "| - | - | - |",
      "| Versions | dialogue\\_bridge | Σε εξέλιξη |",
      "| Comments | agentic\\_ui | Planned |",
      "| Export | sandbox | Done |",
    ]);
  });

  it("changes nothing outside the table", () => {
    const outside = (markdown: string) => lines(markdown).filter((line) => !line.startsWith("|"));
    expect(outside(out)).toEqual(outside(brief));
  });

  it("keeps Greek text byte for byte", () => {
    const greek = (markdown: string) => markdown.match(/[Ͱ-Ͽἀ-῿]+/g) ?? [];
    expect(greek(out)).toEqual(greek(brief));
  });

  it("is stable: a second round trip changes nothing", () => {
    expect(roundTrip(out)).toBe(out);
  });

  it("parses to the node types the canvas renders", () => {
    const value = markdownToValue(brief);
    expect(value[0].type).toBe("h1");
    expect(value.some((node) => node.type === "table")).toBe(true);
    expect(value.filter((node) => node.listStyleType === "disc")).toHaveLength(5);
    expect(value.filter((node) => node.listStyleType === "decimal")).toHaveLength(3);
  });
});

describe("canvas markdown — safety", () => {
  it("keeps raw HTML as text, never as an element", () => {
    const value = markdownToValue('<img src=x onerror="alert(1)">\n\nText <b>bold</b>.\n');
    const types = new Set<string>();
    const walk = (nodes: unknown[]) => {
      for (const node of nodes as { type?: string; children?: unknown[] }[]) {
        if (node.type) types.add(node.type);
        if (node.children) walk(node.children);
      }
    };
    walk(value);
    expect([...types].sort()).toEqual(["p"]);
    // Serialized back as text too (remark normalizes its attributes' quoting).
    expect(valueToMarkdown(value)).toContain('<img src="x" onerror="alert(1)" />');
  });
});

describe("canvas outline and heading folds", () => {
  const value = markdownToValue(brief);
  const outline = getOutline(value);

  it("lists the title and the numbered sections, by level", () => {
    expect(outline.map(({ level, text }) => [level, text])).toEqual([
      [1, "Σχέδιο έργου: Canvas documents for mAgenticX"],
      [2, "1. Στόχοι — Goals"],
      [2, "2. Εύρος — Scope"],
      [2, "3. Επόμενα βήματα — Next steps"],
    ]);
  });

  it("folds a section up to the next heading of its level", () => {
    const [, goals, scope] = outline;
    const hidden = getHiddenBlocks(value, [goals.index]);
    expect(hidden[0]).toBe(goals.index + 1);
    expect(hidden.at(-1)).toBe(scope.index - 1);
  });

  it("folds the whole document under the title", () => {
    expect(getHiddenBlocks(value, [0])).toHaveLength(value.length - 1);
  });
});
