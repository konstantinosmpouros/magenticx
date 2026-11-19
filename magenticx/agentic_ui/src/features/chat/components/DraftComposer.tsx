import { ChatInputBar, type ChatInputBarProps } from "@/features/chat/components/ChatInputBar";
import {
  useSlashCommands,
  type SlashCommandsOptions,
} from "@/features/chat/hooks/useSlashCommands";
import { useWorkspaceStore } from "@/shared/stores/workspaceStore";

type DraftComposerProps = Omit<
  ChatInputBarProps,
  "currentMessage" | "setCurrentMessage" | "slash"
> & {
  /** The slash-command menu's options; the draft is supplied here. */
  slashOptions: Omit<SlashCommandsOptions, "draft" | "setDraft">;
  /** Off while voice mode owns the composer. */
  slashEnabled: boolean;
};

/**
 * The chat composer bound to the draft in the workspace store (plan 45).
 *
 * The one component that subscribes to the draft's text, together with the
 * slash-command menu that reads it, so a keystroke re-renders the input bar
 * and nothing around it — not the shell, the sidebar or the conversation. A
 * thin wrapper rather than a change to ChatInputBar, which keeps taking the
 * draft as props.
 */
export function DraftComposer({
  slashOptions,
  slashEnabled,
  ...inputBarProps
}: DraftComposerProps) {
  const draft = useWorkspaceStore((s) => s.draft);
  const setDraft = useWorkspaceStore((s) => s.setDraft);
  const slash = useSlashCommands({ ...slashOptions, draft, setDraft });
  return (
    <ChatInputBar
      {...inputBarProps}
      currentMessage={draft}
      setCurrentMessage={setDraft}
      slash={slashEnabled ? slash : null}
    />
  );
}
