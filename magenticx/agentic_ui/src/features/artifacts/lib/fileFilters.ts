/**
 * The Artifacts page's filters and per-type presentation: which chips exist,
 * what each file type looks like, and how a row's date reads.
 *
 * The type list mirrors the bridge's (`utils/user_files.py`), which derives a
 * file's type from its MIME type or extension; the page only labels it.
 */
import {
  File,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  Presentation,
  type LucideIcon,
} from "lucide-react";

import type { UserFileKind, UserFileType } from "@/shared/lib/types";

/** "All" is no filter; the others are the bridge's `kind` values. */
export type KindFilter = "all" | UserFileKind;
/** "all" is no filter; the others are the bridge's `type` values. */
export type TypeFilter = "all" | UserFileType;

export const KIND_FILTERS: { id: KindFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "input", label: "Inputs" },
  { id: "output", label: "Outputs" },
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

/** Extensions that are code or data rather than prose: they get the code icon. */
const CODE_EXTENSIONS = new Set([
  "json", "yaml", "yml", "xml", "html", "css", "js", "jsx", "ts", "tsx", "py", "sh", "sql", "toml", "ini",
]);

/** A file's extension in upper case (`MD`, `DOCX`), or "" when it has none. */
export function fileExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && dot < fileName.length - 1 ? fileName.slice(dot + 1).toUpperCase() : "";
}

/** The row's icon: the type's, except code and data files read as code. */
export function fileIcon(type: UserFileType, fileName: string): LucideIcon {
  if (type === "text" && CODE_EXTENSIONS.has(fileExtension(fileName).toLowerCase())) return FileCode2;
  return FILE_TYPE_META[type].icon;
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

/** A row's date: "18 Nov 2026"; an unparseable stamp shows nothing rather than "Invalid Date". */
export function formatFileDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : DATE_FORMAT.format(date);
}
