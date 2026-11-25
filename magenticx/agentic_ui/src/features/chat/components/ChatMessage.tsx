import { memo, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Card } from "@/shared/ui/card";
import { Button } from "@/shared/ui/button";
import type {
  Agent,
  EditAttachments,
  MessageOut,
  RunTimeline,
  ThinkingState,
} from "@/shared/lib/types";
import type { LucideIcon } from "lucide-react";
import { Plus } from "lucide-react";
import { HiArrowUp } from "react-icons/hi";
import StarBorder from "@/shared/ui/react_bits/star_border";
import { AIActionBar, UserActionBar } from "./message_parts/ActionBars";
import { answerGroupText, type AnswerGroupPlace } from "@/features/chat/lib/answerGroups";
import { citationsToPlainText } from "@/features/chat/lib/citationText";
import { useCitationSources } from "@/shared/lib/citations-context";
import { MessageAttachments } from "./message_parts/MessageAttachments";
import { MessageContent } from "./message_parts/Content";
import { EditAttachmentStrip } from "./message_parts/EditAttachmentStrip";
import { CanvasEditChip } from "./message_parts/CanvasEditChip";
import { PlanSidePanel, SubagentsSidePanel } from "./message_parts/RunSidePanels";
import { AnswerSourcesPanel } from "./message_parts/AnswerSourcesPanel";
import { useAnswerSources } from "@/features/chat/hooks/useAnswerSources";
import { MessageTaskTree } from "./message_parts/MessageTaskTree";
import { AgentRunTimeline } from "./AgentRunTimeline";
import { useRunTimeline } from "@/features/inference";
import { ShimmeringText } from "@/shared/ui/shadcn-io/shimmering-text";

/** The bubble, animatable: a user message opening into its editor glides to full width. */
const MotionCard = motion.create(Card);

// The bubble's open/close: 300ms (a layout shift), ease-out; transform only (FLIP).
const EDIT_LAYOUT = { layout: { duration: 0.3, ease: [0.22, 1, 0.36, 1] } } as const;
// The editor's footer arrives once the bubble has mostly opened.
const EDIT_FOOTER = { duration: 0.2, delay: 0.12, ease: "easeOut" } as const;

type ChatMessageProps = {
  message: MessageOut;
  showMessageTokenUsage?: boolean;
  isEditing: boolean;
  editingDraft?: string;
  /** The files the open edit keeps and adds; set on the edited message only. */
  editingAttachments?: EditAttachments;
  editingBusy?: boolean;
  onChangeEditDraft?: (value: string) => void;
  onChangeEditAttachments?: (value: EditAttachments) => void;
  onCancelEdit?: () => void;
  onSubmitEdit?: () => void;
  AgentIcon: LucideIcon;
  currentAgent?: Agent;
  resolveMessageAgent?: (message: MessageOut) => { name: string; Icon: LucideIcon };
  copiedId: string | null;
  onCopy: (content: string, messageId: string) => void;
  onLike: (message: MessageOut) => void;
  onDislike: (message: MessageOut) => void;
  onReportMessage?: (message: MessageOut) => void;
  conversationIsReported?: boolean;
  onRetryMessage?: (message: MessageOut) => void;
  onForkMessage?: (message: MessageOut) => void;
  onShareMessage?: (message: MessageOut) => void;
  onReadAloud?: (message: MessageOut) => void;
  speakingMessageId?: string | null;
  readOnly?: boolean;
  isStreaming?: boolean;
  onFlashUserActionBar: (messageId: string) => void;
  onRequestEdit?: (message: MessageOut) => void;
  userActionVisibilityClass: string;
  thinkingState?: ThinkingState | null;
  expandedThinking: Record<string, boolean>;
  onToggleThinking: (key: string, next?: boolean) => void;
  activeBranchPath?: string[];
  streamingMessageId?: string | null;
  // The in-flight run's incrementally-folded timeline; only the streaming
  // target message renders from it, every other message replays its own
  // persisted event log via useRunTimeline.
  liveTimeline?: RunTimeline | null;
  isImageFile: (attachment: any) => boolean;
  onDownloadAttachment: (attachment: any, message: MessageOut) => void;
  /** Fetches an attachment's bytes (a generated image shown inline). */
  onLoadAttachment?: (attachment: any, message: MessageOut) => Promise<Blob>;
  onPreviewAttachment: (attachment: any, message: MessageOut) => void;
  onImageClick: (url: string) => void;
  branchData: BranchData;
  /** The answer group this assistant message belongs to (lib/answerGroups). */
  answerGroup?: AnswerGroupPlace;
  /** The branch switcher the group's bar shows: the alternatives of the whole
   *  answer, which a "Try again" creates at the group's first message. */
  groupBranchData?: BranchData;
};

type BranchData = {
  parentId: string | null;
  options?: MessageOut[];
  selectionIndex: number;
  onSelectBranch?: (parentId: string | null, branchIndex: number) => void;
};

function ChatMessageView({
  message,
  showMessageTokenUsage = false,
  isEditing,
  editingDraft,
  editingAttachments,
  editingBusy,
  onChangeEditDraft,
  onChangeEditAttachments,
  onCancelEdit,
  onSubmitEdit,
  AgentIcon,
  currentAgent,
  resolveMessageAgent,
  copiedId,
  onCopy,
  onLike,
  onDislike,
  onReportMessage,
  conversationIsReported = false,
  onRetryMessage,
  onForkMessage,
  onShareMessage,
  onReadAloud,
  speakingMessageId,
  readOnly = false,
  isStreaming,
  onFlashUserActionBar,
  onRequestEdit,
  userActionVisibilityClass,
  thinkingState = null,
  expandedThinking,
  onToggleThinking,
  activeBranchPath,
  streamingMessageId,
  liveTimeline = null,
  isImageFile,
  onDownloadAttachment,
  onLoadAttachment,
  onPreviewAttachment,
  onImageClick,
  branchData,
  answerGroup,
  groupBranchData,
}: ChatMessageProps) {
  const isUser = message.sender === "user";
  const isAi = message.sender === "ai";
  const isTempUserMessage = isUser && String(message.id ?? "").startsWith("temp-");
  const reduceMotion = useReducedMotion();
  const editFileInputRef = useRef<HTMLInputElement>(null);
  const [openRunPanel, setOpenRunPanel] = useState<"plan" | "subagents" | "sources" | null>(null);
  // Per-message agent for the AI action bar. With a resolver (main chat) we get
  // catalog name + icon; without one (e.g. shared view) we fall back to the
  // denormalized per-message agentName and the conversation's icon.
  const aiAgent = resolveMessageAgent
    ? resolveMessageAgent(message)
    : { name: message.agentName ?? currentAgent?.name ?? "Unknown agent", Icon: AgentIcon };
  // A click anywhere on the user's bubble opens it for editing (as in Cursor);
  // the bar's pencil stays for people who look for it.
  const canClickToEdit =
    isUser && !readOnly && !isTempUserMessage && !isEditing && Boolean(onRequestEdit);
  // While editing, the bubble becomes a small composer: the card surface and a
  // primary ring, instead of the dark user-bubble fill.
  const bubbleClass = isUser
    ? isEditing
      ? "chat-user-bubble ml-auto w-full max-w-full overflow-hidden border-primary/40 bg-card px-3 pb-2.5 pt-3 text-card-foreground shadow-elegant ring-4 ring-primary/10 transition-colors duration-200"
      : `chat-user-bubble overflow-hidden p-5 bg-chat-user text-chat-user-foreground ml-auto shadow-card border-border max-w-[85%] md:max-w-[75%] transition-[box-shadow,background-color] duration-200 ${
          canClickToEdit
            ? "cursor-pointer hover:ring-2 hover:ring-primary/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
            : ""
        }`
    : "bg-gradient-card text-card-foreground bg-transparent shadow-none border-transparent w-full max-w-full";

  /**
   * Open the editor on a click in the bubble, unless the click was really
   * something else: following a link, or the end of selecting text to copy.
   */
  const handleBubbleClick = (event: MouseEvent<HTMLDivElement>) => {
    if (!canClickToEdit) return;
    if ((event.target as HTMLElement).closest("a, button")) return;
    if (window.getSelection()?.toString()) return;
    onRequestEdit?.(message);
  };
  const handleBubbleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!canClickToEdit || event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onRequestEdit?.(message);
    }
  };
  // Only a user bubble animates its layout: an answer's card changes size on
  // every streamed token, and measuring it each frame would cost for nothing.
  const animateLayout = isUser && !reduceMotion;

  const branchPathActive = useMemo(() => {
    if (!thinkingState?.branchPath || !activeBranchPath) return false;
    const branch = thinkingState.branchPath;
    if (activeBranchPath.length < branch.length) return false;
    for (let i = 0; i < branch.length; i += 1) {
      if (branch[i] !== activeBranchPath[i]) return false;
    }
    return true;
  }, [thinkingState?.branchPath, activeBranchPath]);

  const isStreamingThisMessage = Boolean(
    isAi && isStreaming && streamingMessageId && streamingMessageId === message.id,
  );
  const isStreamingTarget = Boolean(
    isStreamingThisMessage && thinkingState?.isActive && branchPathActive,
  );

  const settledTimeline = useRunTimeline(isAi ? message : null);
  const timeline = isStreamingThisMessage && liveTimeline ? liveTimeline : settledTimeline;

  const showAttachments = Array.isArray(message.attachments) && message.attachments.length > 0;
  const showActionBar = isAi
    ? !(isStreamingTarget || isStreamingThisMessage)
    : !isTempUserMessage && !isEditing;
  const showUserSending = isTempUserMessage && !isEditing;

  const planForPanel = !isStreamingThisMessage && timeline?.terminal ? timeline.plan : null;
  const subagentCount = !isStreamingThisMessage && timeline?.terminal ? timeline.subagentCount : 0;

  // One bar per answer group, on its last message (lib/answerGroups): Try again
  // regenerates the whole answer from its first message, Copy takes every part,
  // Fork and the rest act on this (last) message so nothing is left out.
  const group = isAi && answerGroup && answerGroup.group.members.length > 1 ? answerGroup : null;
  const carriesActionBar = !group || group.isTail;
  const groupHead = group?.group.head;
  const handleGroupRetry =
    onRetryMessage && groupHead ? () => onRetryMessage(groupHead) : onRetryMessage;
  // Copy carries citations as numbered references plus a Sources list (plan 42).
  const citationSources = useCitationSources();
  const handleGroupCopy = group
    ? (_content: string, messageId: string) =>
        onCopy(answerGroupText(group.group, citationSources), messageId)
    : (content: string, messageId: string) =>
        onCopy(citationsToPlainText(content, citationSources), messageId);

  // The answer's Sources panel covers the whole group (plan 42): what every
  // member's text points at, then the rest its runs found.
  const groupMembers = group?.group.members;
  const answerMembers = useMemo(
    () => (isAi && carriesActionBar ? (groupMembers ?? [message]) : []),
    [carriesActionBar, groupMembers, isAi, message],
  );
  const sourcesOfAnswer = useAnswerSources(
    answerMembers,
    isAi && carriesActionBar && !isStreamingThisMessage ? timeline?.sources : null,
  );
  const hasAnswerSources = sourcesOfAnswer.cited.length + sourcesOfAnswer.more.length > 0;

  const timestampLabel = useMemo(
    () =>
      message.created_at.toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      }),
    [message.created_at],
  );

  // The live reply before the agent's first block: nothing to show yet. The
  // thinking orb under the conversation (AiTransitionIndicator) stands in for
  // it, and the empty row collapses (ChatBody) so the answer, when it comes,
  // starts where the orb is.
  if (isStreamingThisMessage && (timeline?.blocks.length ?? 0) === 0 && !showAttachments) {
    return null;
  }

  return (
    <div
      className={`space-y-2 md:space-y-2 ${isUser ? "flex flex-col items-end" : ""} group/message`}
    >
      {/* While editing, the files sit inside the editor, where they can be removed. */}
      {showAttachments && !isEditing && (
        <MessageAttachments
          message={message}
          isImageFile={isImageFile}
          onDownloadAttachment={onDownloadAttachment}
          onPreviewAttachment={onPreviewAttachment}
          onImageClick={onImageClick}
        />
      )}

      {/* Ask agent from the canvas (plan 44, Phase 4.3): the document and the
          passage it was about, as a card above the bubble. */}
      {isUser && message.canvasEdit && !isEditing ? (
        <CanvasEditChip edit={message.canvasEdit} />
      ) : null}

      <MotionCard
        // Measured only when the edit state flips (layoutDependency): without
        // it every user bubble re-animated, stretched, on any reflow of the
        // list (a scrollbar, the composer growing, a streamed answer).
        layout={animateLayout}
        layoutDependency={isEditing}
        transition={EDIT_LAYOUT}
        // The radius goes through style so Framer corrects it while the card
        // is scaled; set in a class, the corners would stretch with it.
        style={isUser ? { borderRadius: isEditing ? 24 : 8 } : undefined}
        className={bubbleClass}
        onClick={canClickToEdit ? handleBubbleClick : undefined}
        onKeyDown={canClickToEdit ? handleBubbleKeyDown : undefined}
        role={canClickToEdit ? "button" : undefined}
        tabIndex={canClickToEdit ? 0 : undefined}
        aria-label={canClickToEdit ? "Edit message" : undefined}
      >
        {/* "position": the content takes its new size at once and only slides,
            counter-scaled against the card, so the text never stretches; the
            card's overflow-hidden reveals it as the card opens. */}
        <motion.div
          layout={animateLayout ? "position" : false}
          layoutDependency={isEditing}
          transition={EDIT_LAYOUT}
          className={`${isEditing ? "space-y-1.5" : "space-y-3"} min-w-0`}
        >
          {isUser ? (
            <>
              {isEditing && editingAttachments && onChangeEditAttachments ? (
                <EditAttachmentStrip
                  message={message}
                  value={editingAttachments}
                  onChange={onChangeEditAttachments}
                  disabled={editingBusy}
                />
              ) : null}
              <MessageContent
                message={message}
                isEditing={isEditing}
                editingDraft={editingDraft}
                editingBusy={editingBusy}
                onChangeEditDraft={onChangeEditDraft}
                onCancelEdit={onCancelEdit}
                onSubmitEdit={onSubmitEdit}
              />
            </>
          ) : timeline && !(isStreamingThisMessage && timeline.blocks.length === 0) ? (
            // While the run's reply is live but the agent hasn't emitted its
            // first block yet (transition phase), render nothing — the thinking
            // orb below is the only "something is happening" signal. Rendering
            // here too would double up ("Reasoning…" + orb).
            <AgentRunTimeline
              timeline={timeline}
              runId={message.id}
              isStreaming={isStreamingThisMessage}
              fallbackThinkingSeconds={message.thinkingTime ?? null}
              expandedThinking={expandedThinking}
              onToggleThinking={onToggleThinking}
              message={message}
              onDownloadAttachment={onDownloadAttachment}
              onLoadAttachment={onLoadAttachment}
              onPreviewAttachment={onPreviewAttachment}
            />
          ) : null}

          {/* The background tasks this answer started (plan 41), live for as
              long as they run — whatever the chat has done since. */}
          {isAi ? <MessageTaskTree message={message} timeline={timeline ?? null} /> : null}

          <div className="text-sm">
            {isUser ? (
              isEditing ? (
                <motion.div
                  initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={EDIT_FOOTER}
                  className="flex items-center gap-2"
                >
                  {/* Add files to the new version, as in the composer. */}
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    className="h-8 w-8 rounded-full text-muted-foreground [&_svg]:size-5 hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]"
                    disabled={editingBusy || !onChangeEditAttachments}
                    onClick={() => editFileInputRef.current?.click()}
                    aria-label="Attach files"
                    title="Attach files & photos"
                  >
                    <Plus className="h-5 w-5" aria-hidden="true" />
                  </Button>
                  <input
                    ref={editFileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    aria-hidden="true"
                    tabIndex={-1}
                    onChange={(event) => {
                      const picked = Array.from(event.currentTarget.files ?? []);
                      event.currentTarget.value = "";
                      if (!picked.length || !editingAttachments || !onChangeEditAttachments) return;
                      onChangeEditAttachments({
                        ...editingAttachments,
                        files: [...editingAttachments.files, ...picked],
                      });
                    }}
                  />
                  <div className="ml-auto flex items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      // The same hover surface as the message action bars.
                      className="h-8 rounded-lg px-2.5 text-muted-foreground transition-colors hover:bg-[hsl(var(--hover-surface))] hover:text-foreground active:bg-[hsl(var(--hover-surface-strong))] focus-visible:bg-[hsl(var(--hover-surface-strong))]"
                      disabled={editingBusy}
                      onClick={() => onCancelEdit?.()}
                    >
                      Cancel
                    </Button>
                    {/* The composer's own send button, so sending looks the same everywhere. */}
                    <StarBorder
                      as="button"
                      type="button"
                      innerClassName="w-9 h-9"
                      className="shadow-elegant transition-smooth hover:opacity-90 active:scale-110 disabled:cursor-not-allowed disabled:opacity-40"
                      color="hsl(var(--primary))"
                      thickness={2}
                      disabled={editingBusy || isStreaming || !editingDraft?.trim()}
                      onClick={() => onSubmitEdit?.()}
                      aria-label="Send the edited message"
                      title="Send the edited message"
                    >
                      <HiArrowUp size={16} aria-hidden="true" />
                    </StarBorder>
                  </div>
                </motion.div>
              ) : (
                <span className="opacity-70">
                  {message.created_at.toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              )
            ) : (
              !isStreamingThisMessage &&
              showActionBar &&
              // An earlier part of a grouped answer has no bar of its own.
              carriesActionBar && (
                <div className="flex w-full flex-wrap items-center gap-2">
                  <AIActionBar
                    message={message}
                    showMessageTokenUsage={showMessageTokenUsage}
                    copiedId={copiedId}
                    onCopy={handleGroupCopy}
                    onLike={onLike}
                    onDislike={onDislike}
                    onReportMessage={onReportMessage}
                    conversationIsReported={conversationIsReported}
                    onRetryMessage={handleGroupRetry}
                    onForkMessage={onForkMessage}
                    onShareMessage={onShareMessage}
                    onReadAloud={onReadAloud}
                    speakingMessageId={speakingMessageId}
                    readOnly={readOnly}
                    isStreaming={isStreaming}
                    branchControls={group ? (groupBranchData ?? branchData) : branchData}
                    agentName={aiAgent.name}
                    AgentIcon={aiAgent.Icon}
                    timestampLabel={timestampLabel}
                    onOpenPlan={planForPanel ? () => setOpenRunPanel("plan") : undefined}
                    onOpenSubagents={
                      subagentCount > 0 ? () => setOpenRunPanel("subagents") : undefined
                    }
                    subagentCount={subagentCount}
                    onOpenSources={hasAnswerSources ? () => setOpenRunPanel("sources") : undefined}
                  />
                </div>
              )
            )}
          </div>
        </motion.div>
      </MotionCard>

      {planForPanel ? (
        <PlanSidePanel
          plan={planForPanel}
          timings={timeline?.planTimings}
          open={openRunPanel === "plan"}
          onOpenChange={(open) => setOpenRunPanel(open ? "plan" : null)}
        />
      ) : null}
      {timeline && subagentCount > 0 ? (
        <SubagentsSidePanel
          timeline={timeline}
          open={openRunPanel === "subagents"}
          onOpenChange={(open) => setOpenRunPanel(open ? "subagents" : null)}
        />
      ) : null}

      {hasAnswerSources ? (
        <AnswerSourcesPanel
          sources={sourcesOfAnswer}
          open={openRunPanel === "sources"}
          onOpenChange={(open) => setOpenRunPanel(open ? "sources" : null)}
        />
      ) : null}

      {showUserSending ? (
        <div className="mt-2 text-right">
          <ShimmeringText
            text="sending"
            className="text-xs font-medium uppercase tracking-wide"
            color="hsl(var(--muted-foreground))"
            shimmeringColor="#2b2d36"
            duration={1.1}
            pause={1.4}
          />
        </div>
      ) : (
        isUser &&
        !isEditing && (
          <UserActionBar
            message={message}
            copiedId={copiedId}
            onCopy={onCopy}
            onFlashUserActionBar={onFlashUserActionBar}
            onRequestEdit={readOnly ? undefined : onRequestEdit}
            branchControls={branchData}
            className={`mt-2 ${userActionVisibilityClass}`}
          />
        )
      )}
    </div>
  );
}

const sameBranchData = (a: BranchData | undefined, b: BranchData | undefined) =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.parentId === b.parentId &&
    a.options === b.options &&
    a.selectionIndex === b.selectionIndex &&
    a.onSelectBranch === b.onSelectBranch);

/**
 * Props equal for rendering: every prop by identity, except the two branch
 * switchers, which the list builds fresh for each row on every render and are
 * compared field by field.
 */
function sameChatMessageProps(prev: ChatMessageProps, next: ChatMessageProps): boolean {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]) as Set<keyof ChatMessageProps>;
  for (const key of keys) {
    if (key === "branchData" || key === "groupBranchData") {
      if (!sameBranchData(prev[key], next[key])) return false;
    } else if (!Object.is(prev[key], next[key])) {
      return false;
    }
  }
  return true;
}

/**
 * One message in the conversation. Memoized (plan 45): while an answer
 * streams, only that answer's props change, so every settled message above it
 * skips the per-frame render. ChatBody hands the rows stable callbacks and
 * gives the live thinking state and the edit draft only to the message that
 * reads them, which is what lets this hold.
 */
export const ChatMessage = memo(ChatMessageView, sameChatMessageProps);
