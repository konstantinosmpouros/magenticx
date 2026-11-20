// @vitest-environment happy-dom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * Plan 45, Phase 6A — the first-load trims keep behaviour:
 * - the shared shiki highlighter keys its cache on the whole text (the old key,
 *   length plus first and last 100 chars, let two blocks collide);
 * - Streamdown's math and raw-HTML plugins are no-ops until they load, then
 *   the real ones;
 * - the CSS shimmer and the native SplitText render their text in the DOM.
 */
import { getCachedTokens, tokenizeCode } from "@/shared/lib/highlighter";
import lazyRehypeKatex, { isKatexReady, loadKatex, needsKatex } from "@/shared/lib/lazyRehypeKatex";
import lazyRehypeRaw, {
  isRehypeRawReady,
  loadRehypeRaw,
  needsRehypeRaw,
} from "@/shared/lib/lazyRehypeRaw";
import SplitText from "@/shared/ui/react_bits/split_text";
import { ShimmeringText } from "@/shared/ui/shadcn-io/shimmering-text";

/** A hast tree, as far as these assertions need one. */
type Tree = { type: "root"; children: unknown[] };
type Transform = (tree: Tree, file: unknown) => void;

const mathTree = (): Tree => ({
  type: "root",
  children: [
    {
      type: "element",
      tagName: "code",
      properties: { className: ["language-math", "math-inline"] },
      children: [{ type: "text", value: "x^2" }],
    },
  ],
});

const plainText = (tokens: { content: string }[][]) =>
  tokens.map((line) => line.map((token) => token.content).join("")).join("\n");

describe("shared highlighter", () => {
  it("never confuses two texts that share their length, start and end", async () => {
    const edge = "x".repeat(120);
    const a = `${edge}\nconst one = 1;\n${edge}`;
    const b = `${edge}\nconst two = 2;\n${edge}`;
    expect(a.length).toBe(b.length);

    const [ta, tb] = await Promise.all([
      tokenizeCode(a, "typescript"),
      tokenizeCode(b, "typescript"),
    ]);
    expect(plainText(ta.tokens)).toBe(a);
    expect(plainText(tb.tokens)).toBe(b);
    expect(getCachedTokens(a, "typescript")).toBe(ta);
    expect(getCachedTokens(b, "typescript")).toBe(tb);
  });

  it("falls back to plain text for a language shiki does not know", async () => {
    const tokens = await tokenizeCode("just words", "not-a-language");
    expect(plainText(tokens.tokens)).toBe("just words");
  });
});

describe("Streamdown plugins on demand", () => {
  it("leaves math as source until KaTeX loads, then renders it", async () => {
    expect(needsKatex("area $$x^2$$")).toBe(true);
    expect(needsKatex("costs $5")).toBe(false);

    const before = mathTree();
    (lazyRehypeKatex({}) as Transform)(before, {});
    expect(JSON.stringify(before)).not.toContain("katex");

    await loadKatex();
    expect(isKatexReady()).toBe(true);

    const after = mathTree();
    (lazyRehypeKatex({}) as Transform)(after, { message: () => undefined });
    expect(JSON.stringify(after)).toContain("katex");
  });

  it("leaves raw HTML untouched until rehype-raw loads, then parses it", async () => {
    expect(needsRehypeRaw("line<br>break")).toBe(true);
    expect(needsRehypeRaw("a < b")).toBe(false);

    const rawTree = (): Tree => ({ type: "root", children: [{ type: "raw", value: "<sup>2</sup>" }] });
    const before = rawTree();
    (lazyRehypeRaw() as Transform)(before, {});
    expect(before.children[0]).toEqual({ type: "raw", value: "<sup>2</sup>" });

    await loadRehypeRaw();
    expect(isRehypeRawReady()).toBe(true);

    const after = rawTree();
    const parsed = ((lazyRehypeRaw() as (tree: Tree) => Tree)(after) ?? after) as Tree;
    expect(JSON.stringify(parsed)).toContain('"tagName":"sup"');
  });
});

describe("CSS text motion", () => {
  it("draws the shimmer as one element with the whole label", () => {
    const { container } = render(<ShimmeringText text="Reasoning..." />);
    const span = container.firstElementChild as HTMLElement;
    expect(span.textContent).toBe("Reasoning...");
    expect(span.children).toHaveLength(0);
    expect(span.className).toContain("animate-shimmer-text");
    expect(span.className).toContain("motion-reduce:animate-none");
  });

  it("splits the greeting into characters but keeps the text whole for readers", () => {
    const { container } = render(<SplitText text="Ask me anything" tag="h2" />);
    const heading = container.querySelector("h2") as HTMLElement;
    expect(heading.getAttribute("aria-label")).toBe("Ask me anything");
    expect(heading.textContent).toBe("Ask me anything");
    expect(heading.querySelectorAll("[data-split-char]")).toHaveLength(13);
    expect(heading.style.willChange).toBe("");
  });
});
