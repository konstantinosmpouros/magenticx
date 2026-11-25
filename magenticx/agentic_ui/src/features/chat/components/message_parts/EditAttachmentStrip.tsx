/**
 * The files of a message being edited: the uploads it keeps and the files
 * added in the editor, each with a remove button.
 *
 * Built here rather than taken from a library: it is the composer's own
 * attachment chip (ChatInputBar), so a file looks the same wherever the user
 * sends it. The composer's strip is bound to its own `File[]`, while an edit
 * mixes stored uploads (by id) with new files, so the chip markup is repeated
 * instead of shared.
 */
import { useEffect, useMemo } from "react";
import { FileText, X } from "lucide-react";
import type { AttachmentOut, EditAttachments, MessageOut } from "@/shared/lib/types";

type EditAttachmentStripProps = {
  message: MessageOut;
  value: EditAttachments;
  onChange: (value: EditAttachments) => void;
  disabled?: boolean;
};

type Chip = {
  key: string;
  name: string;
  imageUrl: string | null;
  onRemove: () => void;
};

const isImageMime = (mime: string | undefined) => Boolean(mime?.startsWith("image/"));

export function EditAttachmentStrip({ message, value, onChange, disabled }: EditAttachmentStripProps) {
  // The new files' image previews, released when the files change or the editor closes.
  const newFileUrls = useMemo(
    () => value.files.map((file) => (isImageMime(file.type) ? URL.createObjectURL(file) : null)),
    [value.files],
  );
  useEffect(
    () => () => newFileUrls.forEach((url) => url && URL.revokeObjectURL(url)),
    [newFileUrls],
  );

  const kept = useMemo(() => {
    const byId = new Map(
      ((message.attachments ?? []) as AttachmentOut[]).map((attachment) => [attachment.id, attachment]),
    );
    return value.keptIds.flatMap((id) => {
      const attachment = byId.get(id);
      return attachment ? [attachment] : [];
    });
  }, [message.attachments, value.keptIds]);

  const chips: Chip[] = [
    ...kept.map((attachment) => ({
      key: `kept-${attachment.id}`,
      name: attachment.name,
      imageUrl:
        isImageMime(attachment.mime) && attachment.data
          ? `data:${attachment.mime};base64,${attachment.data}`
          : null,
      onRemove: () =>
        onChange({ ...value, keptIds: value.keptIds.filter((id) => id !== attachment.id) }),
    })),
    ...value.files.map((file, index) => ({
      key: `new-${index}-${file.name}`,
      name: file.name,
      imageUrl: newFileUrls[index],
      onRemove: () => onChange({ ...value, files: value.files.filter((_, i) => i !== index) }),
    })),
  ];

  if (chips.length === 0) return null;

  return (
    <div className="scrollbar-none -mx-1 overflow-x-auto px-1 pb-1" aria-label="Attached files">
      <div className="flex min-w-max flex-nowrap items-center gap-2">
        {chips.map((chip) => (
          <div
            key={chip.key}
            className={`relative shrink-0 overflow-hidden rounded-2xl border border-border bg-secondary/70 text-secondary-foreground shadow-card ${
              chip.imageUrl
                ? "flex items-center p-1.5"
                : "flex max-w-[14rem] items-center gap-2.5 px-3 py-2.5 md:max-w-[16rem]"
            }`}
          >
            {chip.imageUrl ? (
              <img src={chip.imageUrl} alt={chip.name} className="h-14 w-14 rounded-xl object-cover" />
            ) : (
              <>
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <FileText size={16} aria-hidden="true" />
                </div>
                <span className="block min-w-0 flex-1 truncate pr-5 text-sm font-medium">{chip.name}</span>
              </>
            )}
            <button
              type="button"
              onClick={chip.onRemove}
              disabled={disabled}
              className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-background/90 text-destructive shadow-sm ring-1 ring-border/70 backdrop-blur transition-smooth hover:text-destructive/80 disabled:opacity-50"
              aria-label={`Remove ${chip.name}`}
            >
              <X size={12} strokeWidth={2.5} className="pointer-events-none" aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
