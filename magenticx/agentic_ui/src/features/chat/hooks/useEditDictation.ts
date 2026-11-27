import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "@/shared/hooks/use-toast";
import { transcribeDictation } from "@/shared/lib/api";
import { toastError } from "@/shared/lib/toast";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

export type EditDictationStatus = "idle" | "recording" | "transcribing";

/**
 * Dictation for the message editor: press to record, press again to stop,
 * and the transcript is handed to `onTranscript` (the editor appends it to
 * the draft). The composer's dictation drives its waveform and review step;
 * the editor only needs record → text, so this keeps to a MediaRecorder and
 * the same transcription route. Recording stops, without transcribing, when
 * `active` turns false (the edit closed) or the component unmounts.
 */
export function useEditDictation(active: boolean, onTranscript: (text: string) => void) {
  const userId = useWorkspaceStore((s) => s.userId);
  const { toast } = useToast();
  const [status, setStatus] = useState<EditDictationStatus>("idle");
  const recorderRef = useRef<MediaRecorder | null>(null);
  const discardRef = useRef(false);
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const transcribe = useCallback(
    async (audio: Blob) => {
      if (!userId) {
        setStatus("idle");
        return;
      }
      setStatus("transcribing");
      try {
        const [, rawExt = "webm"] = (audio.type || "audio/webm").split("/");
        const text = (await transcribeDictation(userId, audio, `dictation-${Date.now()}.${rawExt.split(";")[0]}`)).trim();
        if (text) onTranscriptRef.current(text);
        else toast({ title: "No speech detected", description: "Please try recording again." });
      } catch (error) {
        toastError(toast, "Dictation failed", error);
      } finally {
        setStatus("idle");
      }
    },
    [toast, userId],
  );

  const start = useCallback(async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (error) {
      toastError(toast, "Microphone unavailable", error);
      return;
    }
    const chunks: Blob[] = [];
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.push(event.data);
    };
    recorder.onstop = () => {
      stream.getTracks().forEach((track) => track.stop());
      recorderRef.current = null;
      if (discardRef.current || chunks.length === 0) {
        setStatus("idle");
        return;
      }
      void transcribe(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
    };
    discardRef.current = false;
    recorderRef.current = recorder;
    recorder.start();
    setStatus("recording");
  }, [toast, transcribe]);

  const stop = useCallback((discard: boolean) => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state === "inactive") return;
    discardRef.current = discard;
    recorder.stop();
  }, []);

  // The edit closed (or the row went away) while recording: drop the take.
  useEffect(() => {
    if (!active) stop(true);
  }, [active, stop]);
  useEffect(() => () => stop(true), [stop]);

  const toggle = useCallback(() => {
    if (status === "idle") void start();
    else if (status === "recording") stop(false);
  }, [start, status, stop]);

  return { status, toggle };
}
