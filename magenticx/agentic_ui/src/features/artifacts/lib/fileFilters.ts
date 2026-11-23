/**
 * The Artifacts page's filters and per-type presentation: which chips exist,
 * what each file type looks like (icon, accent colour, cover drawing), how
 * the list is grouped by date, and how a file's age reads.
 *
 * The type list mirrors the bridge's (`engine/conversations/user_files.py`),
 * which derives a file's type from its MIME type or extension; the page only
 * labels it.
 */
import {
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Layers,
  Paperclip,
  Presentation,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

import type { UserFileKind, UserFileType } from "@/shared/lib/types";

/** "All" is no filter; the others are the bridge's `kind` values. */
export type KindFilter = "all" | UserFileKind;
/** "all" is no filter; the others are the bridge's `type` values. */
export type TypeFilter = "all" | UserFileType;

export const KIND_FILTERS: { id: KindFilter; label: string; icon: LucideIcon }[] = [
  { id: "all", label: "All", icon: Layers },
  { id: "input", label: "Inputs", icon: Paperclip },
  { id: "output", label: "Outputs", icon: Sparkles },
];

export const TYPE_FILTERS: { id: TypeFilter; label: string }[] = [
  { id: "all", label: "Any type" },
  { id: "doc", label: "Documents" },
  { id: "sheet", label: "Sheets" },
  { id: "slides", label: "Slides" },
  { id: "pdf", label: "PDFs" },
  { id: "image", label: "Images" },
  { id: "text", label: "Text" },
  { id: "other", label: "Other" },
];

/** Each type's icon and short label, for a row's leading tile. */
export const FILE_TYPE_META: Record<UserFileType, { icon: LucideIcon; label: string }> = {
  doc: { icon: FileText, label: "Document" },
  sheet: { icon: FileSpreadsheet, label: "Sheet" },
  slides: { icon: Presentation, label: "Slides" },
  pdf: { icon: FileType2, label: "PDF" },
  image: { icon: FileImage, label: "Image" },
  text: { icon: FileText, label: "Text" },
  other: { icon: File, label: "File" },
};

/** Extensions that are code or data rather than prose: they get the code icon, colour and cover. */
const CODE_EXTENSIONS = new Set([
  "json", "yaml", "yml", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "sh", "sql", "toml", "ini",
]);

/** A file's extension in upper case (`MD`, `DOCX`), or "" when it has none. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toUpperCase() : "";
}

const isCode = (type: UserFileType, fileName: string) =>
  type === "text" && CODE_EXTENSIONS.has(fileExtension(fileName).toLowerCase());

/** The row's icon: the type's, except code and data files read as code. */
export function fileIcon(type: UserFileType, fileName: string): LucideIcon {
  if (isCode(type, fileName)) return FileCode2;
  return FILE_TYPE_META[type].icon;
}

/**
 * What a file's cover draws (`ArtifactCover`): one small picture per family —
 * a page of prose, a grid, a slide, a framed picture, indented code — so the
 * grid reads by shape before anyone reads a name.
 */
export type FileVisual = "doc" | "pdf" | "sheet" | "slides" | "image" | "code" | "text" | "other";

export function fileVisual(type: UserFileType, fileName: string): FileVisual {
  if (isCode(type, fileName)) return "code";
  return type;
}

/**
 * A family's accent, as Tailwind classes over the `--file-*` theme tokens
 * (styles/theme/light.css, midnight.css) — whole literal class names, so the
 * build keeps them. `text` colours an icon or mark, `soft` tints a tile,
 * `ring` outlines it, `dot` is a solid swatch, `wash` starts a cover's
 * gradient.
 */
export type FileAccent = { text: string; soft: string; ring: string; dot: string; wash: string };

const ACCENTS: Record<FileVisual, FileAccent> = {
  doc: { text: "text-file-word", soft: "bg-file-word/10", ring: "ring-file-word/25", dot: "bg-file-word", wash: "from-file-word/[0.14]" },
  pdf: { text: "text-file-pdf", soft: "bg-file-pdf/10", ring: "ring-file-pdf/25", dot: "bg-file-pdf", wash: "from-file-pdf/[0.13]" },
  sheet: { text: "text-file-sheet", soft: "bg-file-sheet/10", ring: "ring-file-sheet/25", dot: "bg-file-sheet", wash: "from-file-sheet/[0.14]" },
  slides: { text: "text-file-slides", soft: "bg-file-slides/10", ring: "ring-file-slides/25", dot: "bg-file-slides", wash: "from-file-slides/[0.14]" },
  image: { text: "text-file-image", soft: "bg-file-image/10", ring: "ring-file-image/25", dot: "bg-file-image", wash: "from-file-image/[0.13]" },
  code: { text: "text-file-code", soft: "bg-file-code/10", ring: "ring-file-code/25", dot: "bg-file-code", wash: "from-file-code/[0.14]" },
  text: { text: "text-file-text", soft: "bg-file-text/10", ring: "ring-file-text/25", dot: "bg-file-text", wash: "from-file-text/[0.13]" },
  other: { text: "text-muted-foreground", soft: "bg-muted/60", ring: "ring-border/60", dot: "bg-muted-foreground", wash: "from-muted-foreground/[0.10]" },
};

export function fileAccent(visual: FileVisual): FileAccent {
  return ACCENTS[visual];
}

/** The accent of a type chip's swatch ("Text" takes prose's, not code's). */
export function typeAccent(type: UserFileType): FileAccent {
  return ACCENTS[type];
}

/** How long the search box waits after the last keystroke before it asks the bridge. */
export const SEARCH_DEBOUNCE_MS = 250;

/** Rows per bridge page ("Load more" fetches the next one). */
export const FILES_PAGE_SIZE = 30;

const DATE_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});
const MONTH_FORMAT = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });
const RELATIVE_FORMAT = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

const DAY_MS = 86_400_000;

/** A row's date: "18 Nov 2026"; an unparseable stamp shows nothing rather than "Invalid Date". */
export function formatFileDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : DATE_FORMAT.format(date);
}

/**
 * A file's age as people say it — "just now", "5 minutes ago", "yesterday",
 * "3 days ago" — and its date once it is a week old, when "23 days ago" stops
 * being easier to place than the date itself. Empty for an unparseable stamp.
 */
export function formatFileAge(iso: string, now: number = Date.now()): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return "";
  const seconds = Math.round((time - now) / 1000);
  const elapsed = Math.abs(seconds);
  if (elapsed < 60) return "Just now";
  if (elapsed < 3600) return RELATIVE_FORMAT.format(Math.round(seconds / 60), "minute");
  if (elapsed < 86_400) return RELATIVE_FORMAT.format(Math.round(seconds / 3600), "hour");
  if (elapsed < 7 * 86_400) return RELATIVE_FORMAT.format(Math.round(seconds / 86_400), "day");
  return formatFileDate(iso);
}

const startOfDay = (date: Date) =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

/**
 * The date section a file falls in — Today, Yesterday, Previous 7 days,
 * Previous 30 days, then one per month ("October 2026") — the buckets the chat
 * sidebar taught people. The list comes newest first, so consecutive files
 * share a section and a section never repeats.
 */
export function dateGroupLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Earlier";
  const days = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  if (days < 30) return "Previous 30 days";
  return MONTH_FORMAT.format(date);
}
