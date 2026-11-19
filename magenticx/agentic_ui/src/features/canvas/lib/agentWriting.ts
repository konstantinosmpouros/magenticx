/**
 * "Agent is writing here" (plan 44 v2): which canvas document the agent is
 * changing right now, and where, read from the live run's timeline.
 *
 * The signal is the run's own tool calls as the AG-UI stream delivers them:
 * the agents service sends a tool call's arguments whole, in one
 * `TOOL_CALL_ARGS` delta (`{"name", "args"}`), when the call is made, and its
 * `TOOL_CALL_RESULT` when it is done. So an `edit_file` / `write_file` step
 * of the timeline with no result yet, whose `file_path` is the open
 * document, is the agent writing that document now (its sub-agents' steps
 * count too). `edit_file`'s `old_string` says where: its first line with
 * text, without its markdown syntax, is looked up in the document's plain
 * text by the view.
 */
import type {
  CanvasAgentWriting,
  RunTimeline,
  ThinkingBlock,
  TimelineBlock,
  TimelineToolExecution,
} from "@/shared/lib/types";

const WRITE_TOOLS = new Set(["edit_file", "write_file"]);

/** The longest line kept to look up (a shorter one is still unique enough). */
const PASSAGE_CHARS = 80;

/** A path as written by the agent or the route, compared on one spelling. */
const samePath = (a: string, b: string): boolean => {
  const norm = (value: string) =>
    `/${value
      .trim()
      .replace(/^\/+/, "")
      .replace(/\/{2,}/g, "/")}`;
  return norm(a) === norm(b);
};

/** The args object of a step (`{"name", "args"}` or the bare args); null while not JSON. */
function stepArgs(argsText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(argsText);
    if (!parsed || typeof parsed !== "object") return null;
    const record = parsed as Record<string, unknown>;
    const args = "args" in record ? record.args : record;
    return args && typeof args === "object" ? (args as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * A line of markdown as it reads: no heading, quote or list markers, no
 * emphasis or code marks, links as their text, no table pipes.
 */
export function readableLine(line: string): string {
  return line
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?)+/, "")
    .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?!\w)/g, "$1$2")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The line of `old_string` to look up in the document: its first one with words. */
export function writingPassage(oldString: string): string | null {
  for (const line of oldString.split("\n")) {
    const text = readableLine(line);
    // A table's rule row or a lone mark has no words to find.
    if (/[\p{L}\p{N}]/u.test(text)) return text.slice(0, PASSAGE_CHARS);
  }
  return null;
}

function* toolSteps(blocks: readonly TimelineBlock[]): Generator<TimelineToolExecution> {
  for (const block of blocks) {
    if (block.kind === "thinking") {
      for (const item of (block as ThinkingBlock).items) if (item.kind === "tool") yield item;
    } else if (block.kind === "subagent") {
      yield* toolSteps(block.blocks);
    }
  }
}

/** The write in progress on `path` in `timeline` (the latest one); null when there is none. */
export function agentWritingIn(
  timeline: RunTimeline | null | undefined,
  path: string,
): CanvasAgentWriting | null {
  if (!timeline || timeline.terminal) return null;
  let found: CanvasAgentWriting | null = null;
  for (const step of toolSteps(timeline.blocks)) {
    if (!WRITE_TOOLS.has(step.name)) continue;
    if (step.state === "output-available" || step.state === "output-error") continue;
    if (step.approval?.status === "rejected") continue;
    const args = stepArgs(step.argsText);
    const filePath = args?.file_path ?? args?.path;
    if (typeof filePath !== "string" || !samePath(filePath, path)) continue;
    const oldString = args?.old_string;
    found = {
      tool: step.name as CanvasAgentWriting["tool"],
      passage:
        step.name === "edit_file" && typeof oldString === "string"
          ? writingPassage(oldString)
          : null,
    };
  }
  return found;
}
