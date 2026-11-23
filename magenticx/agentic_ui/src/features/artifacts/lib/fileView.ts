/**
 * What a card or a row of the Artifacts page shows for one file, derived in
 * one place so the grid and the list never disagree about a file's title, its
 * colour or whether it opens in the canvas.
 */
import type { LucideIcon } from "lucide-react";

import { canvasDocumentPath } from "@/shared/lib/canvasDocuments";
import type { UserFile } from "@/shared/lib/types";
import { formatBytes } from "@/features/attachments/components/attachment_preview_parts/registry";
import {
  FILE_TYPE_META,
  fileAccent,
  fileExtension,
  fileIcon,
  fileVisual,
  formatFileAge,
  formatFileDate,
  type FileAccent,
  type FileVisual,
} from "@/features/artifacts/lib/fileFilters";

export type FileView = {
  /** An agent made and presented it (vs. the user attached it). */
  output: boolean;
  /** The heading: the title the agent gave it, else its file name. */
  title: string;
  /** The title is not the file name, so the name is shown under it. */
  showFileName: boolean;
  conversation: string;
  extension: string;
  typeLabel: string;
  visual: FileVisual;
  accent: FileAccent;
  Icon: LucideIcon;
  /** "18.0 KB", or "" when the bridge sent no size. */
  size: string;
  /** "3 hours ago" / "18 Nov 2026". */
  age: string;
  /** The full date, for the age's tooltip. */
  date: string;
  /** A generated `.md` opens in its conversation's canvas (plan 44, Phase 4.1); null otherwise. */
  canvasPath: string | null;
};

export function describeFile(file: UserFile, now: number = Date.now()): FileView {
  const output = file.kind === "output";
  const title = file.title?.trim() || file.fileName;
  const visual = fileVisual(file.type, file.fileName);
  return {
    output,
    title,
    showFileName: title !== file.fileName,
    conversation: file.conversationTitle || "Untitled conversation",
    extension: fileExtension(file.fileName),
    typeLabel: FILE_TYPE_META[file.type].label,
    visual,
    accent: fileAccent(visual),
    Icon: fileIcon(file.type, file.fileName),
    size: formatBytes(file.size ?? undefined),
    age: formatFileAge(file.createdAt, now),
    date: formatFileDate(file.createdAt),
    canvasPath: output ? canvasDocumentPath(file) : null,
  };
}
