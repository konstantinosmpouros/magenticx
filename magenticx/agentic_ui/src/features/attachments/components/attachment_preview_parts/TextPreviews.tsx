import * as React from "react";
import Papa from "papaparse";
import { Check, Copy } from "lucide-react";

import { Button } from "@/shared/ui/button";
import { MarkdownRenderer } from "@/shared/ui/markdownRenderer";
import { getCachedTokens, tokenizeCode, type TokenizedCode } from "@/shared/lib/highlighter";
import { cn } from "@/shared/lib/utils";

type TextPreviewProps = {
  content: string;
  language?: string;
  className?: string;
};

function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(content);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };

  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      className="h-8 gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 text-xs text-white/75 hover:bg-white/[0.08] hover:text-white"
      onClick={() => void handleCopy()}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

/**
 * Above this size a code file is shown as plain text: tokenizing (and rendering
 * a span per token for) a multi-megabyte file would stall the main thread.
 */
const HIGHLIGHT_LIMIT_CHARS = 200_000;

/**
 * The preview's highlight, from the app's one shared shiki instance (plan 45:
 * highlight.js is gone). Plain text shows at once; the tokens replace it when
 * the grammar has loaded, or straight away when the same text was seen before.
 */
function usePreviewTokens(content: string, language: string | undefined): TokenizedCode | null {
  const lang = language || "text";
  const highlightable = content.length <= HIGHLIGHT_LIMIT_CHARS;
  const cached = React.useMemo(
    () => (highlightable ? getCachedTokens(content, lang) : null),
    [content, lang, highlightable],
  );
  const [loaded, setLoaded] = React.useState<{
    content: string;
    lang: string;
    tokens: TokenizedCode;
  } | null>(null);

  React.useEffect(() => {
    if (!highlightable || cached) return;
    let cancelled = false;
    tokenizeCode(content, lang)
      .then((tokens) => {
        if (!cancelled) setLoaded({ content, lang, tokens });
      })
      .catch(() => {
        // Highlighting is decoration: on failure the plain text stays.
      });
    return () => {
      cancelled = true;
    };
  }, [content, lang, highlightable, cached]);

  if (cached) return cached;
  // A result for an earlier file or language is never shown for this one.
  return loaded && loaded.content === content && loaded.lang === lang ? loaded.tokens : null;
}

export function CodeTextPreview({ content, language, className }: TextPreviewProps) {
  const tokenized = usePreviewTokens(content, language);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#151515]",
        className,
      )}
    >
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-white/45">
          {language || "text"}
        </span>
        <CopyButton content={content} />
      </div>
      <pre className="min-h-0 flex-1 overflow-auto p-4 text-[0.82rem] leading-6 text-white/85">
        {tokenized ? (
          <code>
            {tokenized.tokens.map((line, lineIndex) => (
              // Lines and tokens never reorder; the index is their identity.
              <React.Fragment key={lineIndex}>
                {lineIndex > 0 ? "\n" : null}
                {line.map((token, tokenIndex) => (
                  <span
                    key={tokenIndex}
                    // The panel is dark in every theme, so it takes the dark
                    // theme's colour (shiki's `--shiki-dark` value).
                    style={{ color: token.htmlStyle?.["--shiki-dark"] ?? token.color }}
                  >
                    {token.content}
                  </span>
                ))}
              </React.Fragment>
            ))}
          </code>
        ) : (
          <code>{content}</code>
        )}
      </pre>
    </div>
  );
}

export function MarkdownPreview({ content }: { content: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#202020]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-white/45">markdown</span>
        <CopyButton content={content} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto bg-[#f8f8f5] p-6 text-[#1f1f1f] dark:bg-[#1d1d1d] dark:text-white">
        <MarkdownRenderer content={content} />
      </div>
    </div>
  );
}

export function JsonPreview({ content }: { content: string }) {
  const parsed = React.useMemo(() => {
    try {
      return JSON.stringify(JSON.parse(content), null, 2);
    } catch {
      return null;
    }
  }, [content]);

  return <CodeTextPreview content={parsed ?? content} language="json" />;
}

/** The rows a CSV preview shows. */
const CSV_PREVIEW_ROWS = 500;

export function CsvPreview({ content }: { content: string }) {
  const rows = React.useMemo(() => {
    // `preview` stops the parser after the rows shown: a large CSV was parsed
    // whole on the main thread only to keep its first 500 rows (plan 45).
    const parsed = Papa.parse<string[]>(content.trim(), {
      skipEmptyLines: true,
      preview: CSV_PREVIEW_ROWS,
    });
    return (parsed.data || []).slice(0, CSV_PREVIEW_ROWS);
  }, [content]);

  const maxColumns = Math.min(
    80,
    rows.reduce((max, row) => Math.max(max, row.length), 0),
  );

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[1.4rem] border border-white/10 bg-[#171717]">
      <div className="flex items-center justify-between border-b border-white/10 px-3 py-2">
        <span className="text-xs font-medium uppercase tracking-wide text-white/45">
          csv · {rows.length} rows previewed
        </span>
        <CopyButton content={content} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="min-w-full border-collapse text-left text-xs text-white/80">
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr
                key={`csv-row-${rowIndex}`}
                className={rowIndex === 0 ? "bg-white/[0.06] text-white" : undefined}
              >
                {Array.from({ length: maxColumns }).map((_, columnIndex) => (
                  <td
                    key={`csv-cell-${rowIndex}-${columnIndex}`}
                    className="max-w-[22rem] whitespace-pre-wrap border border-white/10 px-3 py-2 align-top"
                  >
                    {row[columnIndex] ?? ""}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
