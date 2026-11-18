import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "@/shared/hooks/use-toast";
import { downloadAttachment, fetchAttachmentBlob } from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import type { UserFile } from "@/shared/lib/types";
import { useAttachmentPreview } from "@/features/attachments/hooks/useAttachmentPreview";

/**
 * useArtifactActions — what a row of the Artifacts page can do with its file:
 * preview it, download it. The page's files come from many conversations, so
 * unlike the chat (which previews against the open conversation) every action
 * carries the file's own conversation and message.
 *
 * Previews reuse the chat's two overlays (`useAttachmentPreview`): images open
 * in the image lightbox, everything else in the attachment preview panel. An
 * image's bytes come through the download route (the inline preview route
 * refuses images by design) into an object URL with the image's own type, and
 * are rendered by an `<img>`, which never runs script — an SVG included.
 */
export function useArtifactActions(userId: string | null) {
  const { toast } = useToast();
  const preview = useAttachmentPreview();
  const { setSelectedImage, openFilePreview, closeFilePreview } = preview;
  // The file whose preview is open: the panel's own Download needs its ids.
  const [previewFile, setPreviewFile] = useState<UserFile | null>(null);
  const [imageName, setImageName] = useState<string | undefined>(undefined);
  const [loadingImageId, setLoadingImageId] = useState<string | null>(null);
  const imageUrlRef = useRef<string | null>(null);

  const releaseImageUrl = useCallback(() => {
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
  }, []);

  // An object URL outlives nothing: released when the page goes.
  useEffect(() => releaseImageUrl, [releaseImageUrl]);

  const download = useCallback(
    async (file: UserFile) => {
      if (!userId) return;
      try {
        toast({ title: "Download starting", description: `Preparing ${file.fileName}`, duration: 2000 });
        await downloadAttachment({
          userId,
          conversationId: file.conversationId,
          messageId: file.messageId,
          blobId: file.blobId,
          filename: file.fileName,
        });
      } catch (error) {
        toastError(toast, "Download failed", error, {
          description: "Unable to download the file. Please try again.",
          duration: 3000,
        });
      }
    },
    [toast, userId],
  );

  const openPreview = useCallback(
    async (file: UserFile) => {
      if (!userId) return;
      if (file.type !== "image") {
        setPreviewFile(file);
        openFilePreview(
          { name: file.fileName, mime: file.mime, size: file.size ?? undefined, blobId: file.blobId },
          { id: file.messageId },
        );
        return;
      }
      setLoadingImageId(file.attachmentId);
      try {
        const bytes = await fetchAttachmentBlob({
          userId,
          conversationId: file.conversationId,
          messageId: file.messageId,
          blobId: file.blobId,
        });
        // The listing says "image" by MIME or by extension; the object URL
        // only ever carries an image type, so it can never render as a page.
        const type = file.mime.startsWith("image/") ? file.mime : "image/png";
        releaseImageUrl();
        imageUrlRef.current = URL.createObjectURL(new Blob([bytes], { type }));
        setImageName(file.fileName);
        setSelectedImage(imageUrlRef.current);
      } catch (error) {
        toastError(toast, "Preview failed", error, {
          description: "Unable to open this image. Try downloading it instead.",
          duration: 3000,
        });
      } finally {
        setLoadingImageId(null);
      }
    },
    [openFilePreview, releaseImageUrl, setSelectedImage, toast, userId],
  );

  const closeImage = useCallback(() => {
    setSelectedImage(null);
    // The lightbox keeps showing the image while it fades out, so the URL is
    // released on the next open or when the page goes, not here.
  }, [setSelectedImage]);

  const closePreview = useCallback(() => {
    closeFilePreview();
  }, [closeFilePreview]);

  return {
    /** The preview panel's target, and the file (with its conversation) behind it. */
    filePreview: preview.selectedFilePreview,
    previewFile,
    /** The image lightbox's source (an object URL), and its download name. */
    imageSrc: preview.selectedImage,
    imageName,
    /** The image row whose bytes are being fetched — its Preview button spins. */
    loadingImageId,
    openPreview: (file: UserFile) => void openPreview(file),
    download: (file: UserFile) => void download(file),
    closePreview,
    closeImage,
  };
}
