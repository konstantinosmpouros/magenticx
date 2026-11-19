import type { BundledLanguage } from "shiki";

import { canvasDocumentTitle } from "@/shared/lib/canvasDocuments";
import { toolLabel } from "@/shared/lib/consts";
import type { SubagentRunStatus } from "@/shared/lib/types";

import { mcpMeta, mcpToolTitle } from "./mcpToolPresentation";

/**
 * What a tool step says about itself in the chain of thought.
 *
 * A step used to be titled with the raw tool name (`read_file`) and to show two
 * panes — the JSON arguments and the raw result. Most of that is noise: what a
 * reader wants is "Read report.csv", and the content in its natural form. This
 * module turns a call's arguments and result into that: a title, a short meta
 * note, and the parsed shapes the step's panes render. Pure functions only — the
 * rendering lives in `message_parts/ToolCallViews.tsx`.
 *
 * Every parser is tolerant by design: a tool result is semi-trusted text that
 * may be truncated, an error, or a format a newer tool version changed. Anything
 * not recognised yields `null`, and the caller falls back to the generic view.
 */

export type ToolArgs = Record<string, unknown>;

/** The parsed arguments as an object, or null while they stream / if malformed. */
export const asToolArgs = (args: unknown): ToolArgs | null =>
  args && typeof args === "object" && !Array.isArray(args) ? (args as ToolArgs) : null;

const str = (args: ToolArgs | null, key: string): string =>
  typeof args?.[key] === "string" ? (args[key] as string) : "";

/** Last path segment: `/conversation/input/image.png` → `image.png`. */
export const basename = (path: string): string => {
  const trimmed = path.replace(/\/+$/, "");
  const name = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return name || path || "/";
};

/** A directory shown without its leading/trailing slashes; the root stays `/`. */
const displayDir = (path: string): string => path.replace(/^\/+|\/+$/g, "") || "/";

const clip = (text: string, max = 60): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// ---------------------------------------------------------------------------
// MCP tools — titles, meta and views live in mcpToolPresentation.ts
// ---------------------------------------------------------------------------

/**
 * Whether a step is an MCP tool. MCP tools arrive under bare names
 * (`tavily-search`); the tool catalog supplies their `serverId`. A
 * `server/tool` name also counts, for a catalog that is not loaded yet.
 */
export const isMcpTool = (name: string, serverId?: string): boolean =>
  Boolean(serverId) || name.includes("/");

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------

const TITLES: Record<string, (args: ToolArgs | null) => string | null> = {
  read_file: (a) => (str(a, "file_path") ? `Read ${basename(str(a, "file_path"))}` : null),
  ls: (a) => `List ${displayDir(str(a, "path") || "/")}`,
  glob: (a) => (str(a, "pattern") ? `Find ${str(a, "pattern")}` : null),
  grep: (a) => {
    const pattern = str(a, "pattern");
    if (!pattern) return null;
    const path = str(a, "path");
    return `Search "${clip(pattern, 40)}"${path ? ` in ${displayDir(path)}` : ""}`;
  },
  write_file: (a) => (str(a, "file_path") ? `Write ${basename(str(a, "file_path"))}` : null),
  edit_file: (a) => (str(a, "file_path") ? `Edit ${basename(str(a, "file_path"))}` : null),
  execute: (a) => (str(a, "command") ? `Run ${clip(str(a, "command"))}` : null),
  remember: (a) => (str(a, "name") ? `Remembered "${str(a, "name")}"` : null),
  forget: (a) => (str(a, "name") ? `Forgot "${str(a, "name")}"` : null),
  search_past_conversations: (a) =>
    str(a, "query") ? `Searched past chats for "${clip(str(a, "query"), 50)}"` : null,
  view_image: (a) => (str(a, "path") ? `View ${basename(str(a, "path"))}` : null),
  create_skill: (a) => (str(a, "name") ? `Created skill "${str(a, "name")}"` : null),
  task: (a) =>
    str(a, "subagent_type")
      ? `Hand off to the ${subagentName(str(a, "subagent_type"))} sub-agent`
      : null,
  start_async_task: (a) =>
    str(a, "subagent_type")
      ? `Start the ${subagentName(str(a, "subagent_type"))} sub-agent in the background`
      : "Start a background task",
  update_async_task: () => "Update a background task",
  check_async_task: () => "Check a background task",
  list_async_tasks: (a) => {
    const filter = str(a, "status_filter");
    return filter && filter !== "all" ? `List ${filter} background tasks` : "List background tasks";
  },
  cancel_async_task: () => "Stop a background task",
  // Canvas comments (plan 44 v2): the document by its canvas title. A reply
  // names it only where the thread can be found (`replyToCommentTitle`).
  reply_to_comment: () => replyToCommentTitle(),
  list_comments: (a) => listCommentsTitle(str(a, "path"), str(a, "status")),
  add_comment: (a) =>
    str(a, "path") ? `Commented on ${canvasDocumentTitle(str(a, "path"))}` : null,
  // The user's suggestions (plan 44, Phase 4.6). Args alone: worded as done;
  // a step with its state and result is titled by `reviewSuggestionsTitle`.
  review_suggestions: (a) => reviewSuggestionsTitle(a),
};

/**
 * `general-purpose` → `general-purpose`, `research_agent` → `research`: the
 * sub-agent's name as it reads inside "the … sub-agent", without a trailing
 * "agent" that would say it twice.
 */
export const subagentName = (type: string): string =>
  type
    .replace(/[_\s]+/g, " ")
    .replace(/[-\s]?(sub[-\s]?)?agent$/i, "")
    .trim() || type;

/**
 * A step's arguments from its streamed `argsText`. TOOL_CALL_ARGS deltas
 * concatenate into a JSON document `{"name", "args"}` — just the args once the
 * JSON is complete, the raw text while it still streams.
 */
export const parseToolArgs = (argsText: string): unknown => {
  const trimmed = argsText.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && "args" in (parsed as Record<string, unknown>)) {
      return (parsed as Record<string, unknown>).args;
    }
    return parsed;
  } catch {
    return trimmed;
  }
};

/** A title built from the call's arguments, for the tools we know; else null. */
export const titleFromArgs = (name: string, args: unknown): string | null =>
  TITLES[name]?.(asToolArgs(args)) || null;

/** The step's title: built from its arguments where we know the tool. */
export const toolTitle = (name: string, args: unknown, serverId?: string): string => {
  if (isMcpTool(name, serverId)) return mcpToolTitle(name, serverId);
  return titleFromArgs(name, args) || toolLabel(name);
};

/** `fetch_weather` → `Fetch weather`, `maxResults` → `Max results`. */
export const humaniseName = (name: string): string => {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_./]+/g, " ")
    .trim()
    .toLowerCase();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : name;
};

/** `- old` / `+ new` lines, highlighted by the diff grammar. */
export const toDiff = (oldText: string, newText: string): string =>
  [
    ...oldText.split("\n").map((line) => `- ${line}`),
    ...newText.split("\n").map((line) => `+ ${line}`),
  ].join("\n");

/** Full path (or pattern) for the title's hover text, where it was shortened. */
export const toolTitleHint = (name: string, args: unknown): string | undefined => {
  const a = asToolArgs(args);
  const path = str(a, "file_path") || str(a, "path");
  if (path) return path;
  if (name === "execute") return str(a, "command") || undefined;
  return undefined;
};

/**
 * Restore line breaks a model escaped twice (a literal backslash + `n` where a
 * line break belongs),
 * but only in text with no real line break — the same narrow rule the agents
 * service applies before saving (harness/tools/text_args.py), so an approval
 * preview shows exactly what will be stored. Used for prose fields only (a
 * skill's instructions, a memory's text), never for file contents.
 */
export const undoDoubleEscaping = (text: string): string => {
  if (text.includes("\n") || !text.includes("\\n")) return text;
  // split/join rather than replaceAll: the project targets ES2020.
  return text
    .split("\\r\\n")
    .join("\n")
    .split("\\n")
    .join("\n")
    .split("\\t")
    .join("\t")
    .split('\\"')
    .join('"');
};

// ---------------------------------------------------------------------------
// Result parsers
// ---------------------------------------------------------------------------

/**
 * `ls` / `glob` results are a Python list repr (`['/a', '/b']`). Returns the
 * paths, plus any trailing non-path entry (the truncation notice) as `note`.
 */
export const parsePathList = (result: string | undefined): { paths: string[]; note?: string } | null => {
  const text = result?.trim();
  if (!text || !text.startsWith("[") || !text.endsWith("]")) return null;
  let items: string[] = [];
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) items = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    const quoted = /'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g;
    for (let match = quoted.exec(text); match; match = quoted.exec(text)) {
      items.push((match[1] ?? match[2]).replace(/\\(.)/g, "$1"));
    }
    if (items.length === 0 && text !== "[]") return null;
  }
  const paths = items.filter((item) => item.startsWith("/"));
  const note = items.find((item) => !item.startsWith("/"));
  return note ? { paths, note } : { paths };
};

export type GrepResult =
  | { mode: "files"; files: string[] }
  | { mode: "count"; counts: { path: string; count: number }[] }
  | { mode: "content"; files: { path: string; lines: { line: string; text: string }[] }[] };

/** `grep` output in its three `output_mode`s; `null` if not recognised. */
export const parseGrep = (result: string | undefined, outputMode: unknown): GrepResult | null => {
  const text = result?.trim();
  if (!text) return null;
  if (text === "No matches found") {
    return outputMode === "content" ? { mode: "content", files: [] } : { mode: "files", files: [] };
  }
  const lines = text.split("\n");
  if (outputMode === "count") {
    const counts = lines
      .map((line) => /^(\/.*):\s*(\d+)$/.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ path: m[1], count: Number(m[2]) }));
    return counts.length ? { mode: "count", counts } : null;
  }
  if (outputMode === "content") {
    const files: { path: string; lines: { line: string; text: string }[] }[] = [];
    for (const line of lines) {
      const header = /^(\/.*):$/.exec(line);
      const hit = /^\s+(\d+):\s?(.*)$/.exec(line);
      if (header) files.push({ path: header[1], lines: [] });
      else if (hit && files.length) files[files.length - 1].lines.push({ line: hit[1], text: hit[2] });
    }
    return files.length ? { mode: "content", files } : null;
  }
  const files = lines.filter((line) => line.startsWith("/"));
  return files.length ? { mode: "files", files } : null;
};

/**
 * `read_file` text is `cat -n` style (`     5\tline`, long lines continued as
 * `5.1`). Returns the code without numbers, its line range and any trailing
 * notice; `null` for anything else (an image block, an error, an empty file).
 */
export const parseNumberedFile = (
  result: string | undefined,
): { code: string; first: number; last: number; note?: string } | null => {
  if (!result) return null;
  const code: string[] = [];
  const notes: string[] = [];
  let first = 0;
  let last = 0;
  for (const line of result.split("\n")) {
    const match = /^\s*(\d+)(?:\.\d+)?\t(.*)$/.exec(line);
    if (!match) {
      if (code.length) notes.push(line);
      continue;
    }
    const [, num, text] = match;
    if (line.trimStart().startsWith(`${num}.`)) {
      // A continuation chunk of the previous long line.
      code[code.length - 1] = `${code[code.length - 1] ?? ""}${text}`;
      continue;
    }
    if (!first) first = Number(num);
    last = Number(num);
    code.push(text);
  }
  if (!code.length) return null;
  const note = notes.join("\n").trim();
  return note ? { code: code.join("\n"), first, last, note } : { code: code.join("\n"), first, last };
};

/** `execute` output with its trailing `[Command … with exit code N]` split off. */
export const parseCommandOutput = (result: string | undefined): { output: string; exitCode?: number } | null => {
  if (result === undefined) return null;
  const match = /\n?\[Command (?:succeeded|failed) with exit code (-?\d+)\]\s*$/.exec(result);
  if (!match) return { output: result };
  return { output: result.slice(0, match.index), exitCode: Number(match[1]) };
};

/**
 * A sandbox run's output split into its streams: the agents service writes
 * stdout first, then `[stderr]` and the error stream, then any notes (files
 * written, a kill reason). Either part may be empty.
 */
export const splitCommandStreams = (output: string): { stdout: string; stderr: string } => {
  const marker = /(^|\n)\[stderr\]\n/.exec(output);
  if (!marker) return { stdout: output, stderr: "" };
  return {
    stdout: output.slice(0, marker.index),
    stderr: output.slice(marker.index + marker[0].length),
  };
};

export type PastChatHit = { header: string; snippet: string };

/** `search_past_conversations` lines: `- [Title · User · created 2026-09-01] text`. */
export const parsePastChats = (result: string | undefined): PastChatHit[] | null => {
  if (!result) return null;
  if (result.trim() === "No relevant past messages found.") return [];
  const hits = result
    .split("\n")
    .map((line) => /^- \[([^\]]*)\]\s?(.*)$/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ header: m[1], snippet: m[2] }));
  return hits.length ? hits : null;
};

/**
 * Whether a write-style tool's result is its routine success message — the
 * title already says it, so only anything else (a failure explained in prose)
 * is worth showing.
 */
const SUCCESS_PREFIXES: Record<string, string[]> = {
  write_file: ["Updated file "],
  edit_file: ["Successfully replaced "],
  remember: ["Saved memory "],
  forget: ["Forgot memory "],
  create_skill: ["Created skill "],
  cancel_async_task: ["Cancelled async subagent task"],
};

export const isRoutineSuccess = (name: string, result: string | undefined): boolean => {
  const text = result?.trim() ?? "";
  if (name === "create_skill" && text.includes("could not enable it")) return false;
  return (SUCCESS_PREFIXES[name] ?? []).some((prefix) => text.startsWith(prefix));
};

// ---------------------------------------------------------------------------
// Canvas comments (plan 44 v2): reply_to_comment / add_comment
// ---------------------------------------------------------------------------

/** The agent's comment tools, which render as comment cards rather than JSON. */
export const isCommentTool = (name: string): boolean =>
  name === "reply_to_comment" || name === "add_comment";

/** "Replied to a comment", plus the document's title when the thread is known. */
export const replyToCommentTitle = (path?: string | null): string =>
  path ? `Replied to a comment on ${canvasDocumentTitle(path)}` : "Replied to a comment";

export type CommentToolOutcome = { ok: true } | { ok: false; reason: string };

/**
 * A comment tool's result: its routine success sentence, or the `Could not …`
 * refusal the agents service writes (harness/tools/canvas_comments/tool.py).
 * Null for anything else — the view shows that text as a plain note.
 */
export const parseCommentToolResult = (result: string | undefined): CommentToolOutcome | null => {
  const text = result?.trim();
  if (!text) return null;
  if (/^Could not (reply|comment)\b/.test(text)) return { ok: false, reason: text };
  if (text.startsWith("Replied in the thread") || text.startsWith("Added the comment")) {
    return { ok: true };
  }
  return null;
};

// ---------------------------------------------------------------------------
// The user's pending suggestions (plan 44, Phase 4.6): review_suggestions
// ---------------------------------------------------------------------------

/** The agent's accept / reject of the user's suggestion set, which renders as its outcome rather than JSON. */
export const REVIEW_SUGGESTIONS_TOOL = "review_suggestions";

/**
 * A `review_suggestions` result: its success sentence, or the `Could not …`
 * refusal the agents service writes (harness/tools/canvas_suggestions/tool.py).
 * Null for anything else — the view shows that text as a plain note.
 */
export const parseSuggestionReviewResult = (result: string | undefined): CommentToolOutcome | null => {
  const text = result?.trim();
  if (!text) return null;
  if (/^Could not (apply|reject|review) the suggestions:/.test(text)) return { ok: false, reason: text };
  if (text.startsWith("Applied the user's suggestions") || text.startsWith("Rejected the user's suggestions")) {
    return { ok: true };
  }
  return null;
};

/**
 * The step's title: "Reviewing your suggestions…" while it runs, then
 * "Applied your suggestions on brief" / "Rejected your suggestions on brief",
 * or "Could not apply your suggestions on brief" when it was refused. Without
 * a `step` (only the arguments known) it is worded as done.
 */
export const reviewSuggestionsTitle = (
  args: unknown,
  step?: { state: string; result?: string },
): string => {
  const a = asToolArgs(args);
  const decision = str(a, "decision");
  const path = str(a, "path");
  const settled = !step || step.state === "output-available" || step.state === "output-error";
  if (!settled || (decision !== "accept" && decision !== "reject")) return "Reviewing your suggestions…";
  const on = path ? ` on ${canvasDocumentTitle(path)}` : "";
  const refused =
    step?.state === "output-error" || parseSuggestionReviewResult(step?.result)?.ok === false;
  if (refused) return `Could not ${decision === "accept" ? "apply" : "reject"} your suggestions${on}`;
  return `${decision === "accept" ? "Applied" : "Rejected"} your suggestions${on}`;
};

// The one read, list_comments. Its result is the plain-text listing whose
// format is stated once, in the agents service's
// harness/tools/canvas_comments/listing.py (module docstring); this parser
// follows it and returns null for anything it does not recognise.

export const LIST_COMMENTS_TOOL = "list_comments";

export type CommentListStatus = "open" | "resolved" | "all";

const listStatus = (value: string): CommentListStatus =>
  value === "resolved" || value === "all" ? value : "open";

/** "Read the comments on brief", plus " · resolved" / " · all" when it was not the open ones. */
export const listCommentsTitle = (path?: string | null, status?: string | null): string => {
  const which = listStatus(status ?? "");
  const base = path ? `Read the comments on ${canvasDocumentTitle(path)}` : "Read the comments";
  return which === "open" ? base : `${base} · ${which}`;
};

export type ListedCommentThread = {
  /** The document the thread is on. */
  path: string;
  resolved: boolean;
  quote: string;
  /** Who wrote the first comment: the user, or the agent. */
  author: "user" | "agent";
  /** The first comment, on one line as the listing gives it. */
  body: string;
};

export type CommentListing = {
  status: CommentListStatus;
  shown: number;
  total: number;
  threads: ListedCommentThread[];
};

const LISTING_HEADER = /^Canvas comments — (open|resolved|all) threads: showing (\d+) of (\d+)\.$/;
const LISTING_DOCUMENT = /^- `[^`]*` — (.+)$/;
const LISTING_THREAD = /^\[thread [^\]]*\] \[(open|resolved(?: by (?:user|you))?)\] «(.*?)» — (user|you): (.*)$/;

/** The listing escapes `<canvas_` in the user's text (fence_safe); show it as written. */
const unfence = (text: string): string => text.replace(/&lt;(\/?)canvas_/g, "<$1canvas_");

/** A `list_comments` result, or null when it is not the listing (a refusal, a changed format). */
export const parseCommentListing = (result: string | undefined): CommentListing | null => {
  const lines = (result ?? "").trim().split("\n");
  const head = LISTING_HEADER.exec(lines[0] ?? "");
  if (!head) return null;
  const threads: ListedCommentThread[] = [];
  let path = "";
  for (const line of lines.slice(1)) {
    const document = LISTING_DOCUMENT.exec(line);
    if (document) {
      path = document[1];
      continue;
    }
    const thread = LISTING_THREAD.exec(line);
    if (!thread) continue;
    threads.push({
      path,
      resolved: thread[1] !== "open",
      quote: unfence(thread[2]),
      author: thread[3] === "you" ? "agent" : "user",
      body: unfence(thread[4]),
    });
  }
  return { status: listStatus(head[1]), shown: Number(head[2]), total: Number(head[3]), threads };
};

/** "3 open threads", "1 resolved thread", "5 threads", "4 of 30 threads", "No open threads". */
export const commentListingSummary = (listing: CommentListing): string => {
  const kind = listing.status === "all" ? "" : `${listing.status} `;
  if (listing.total === 0) return `No ${kind}threads`;
  const noun = listing.total === 1 ? "thread" : "threads";
  const count = listing.shown < listing.total ? `${listing.shown} of ${listing.total}` : `${listing.total}`;
  return `${count} ${kind}${noun}`;
};

/** A `list_comments` refusal (`Could not list comments: …`), or null. */
export const commentListingRefusal = (result: string | undefined): string | null => {
  const text = result?.trim() ?? "";
  return text.startsWith("Could not list comments") ? text : null;
};

/** A passage on one line, for a muted «…» quote under the title. */
export const oneLinePassage = (text: string): string => text.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------
// Background tasks (plan 41): deepagents' check / list results
// ---------------------------------------------------------------------------

/** A task status as deepagents reports it, in the sub-agent cards' vocabulary. */
export const asyncTaskRunStatus = (status: string): SubagentRunStatus | null => {
  switch (status) {
    case "pending":
      return "pending";
    case "running":
      return "running";
    case "waiting":
      return "awaiting_approval";
    case "success":
      return "done";
    case "error":
    case "timeout":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "cancelled";
    default:
      return null;
  }
};

/** How a status reads in a step's meta (the same words as the cards' chips). */
const STATUS_LABELS: Record<SubagentRunStatus, string> = {
  pending: "starting",
  running: "running",
  awaiting_approval: "awaiting approval",
  waiting_children: "sub-agents working",
  stopping: "stopping",
  done: "done",
  failed: "failed",
  cancelled: "cancelled",
};

export type TaskCheck = {
  status: SubagentRunStatus;
  answer?: string;
  error?: string;
  note?: string;
};

/**
 * `check_async_task`'s result: JSON `{status, result?, error?, note?}` (its
 * answer's text inlined as `result` when it has no media). Null when it is not
 * that shape — the step then shows the raw result.
 */
export const parseTaskCheck = (result: string | undefined): TaskCheck | null => {
  if (!result) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  const body = asToolArgs(parsed);
  const status = body && typeof body.status === "string" ? asyncTaskRunStatus(body.status) : null;
  if (!body || !status) return null;
  const textOf = (key: string) => (typeof body[key] === "string" && body[key] ? (body[key] as string) : undefined);
  return { status, answer: textOf("result"), error: textOf("error"), note: textOf("note") };
};

export type TaskListEntry = { taskId: string; agent: string; status: SubagentRunStatus };

const TASK_LIST_LINE = /^- task_id:\s*(\S+)\s+agent:\s*(\S+)\s+status:\s*(\S+)\s*$/;

/**
 * `list_async_tasks`'s result: `N tracked task(s):` then one
 * `- task_id: …  agent: …  status: …` line per task, or the "none" sentence
 * (an empty list). Null when it is neither.
 */
export const parseTaskList = (result: string | undefined): TaskListEntry[] | null => {
  const text = result?.trim();
  if (!text) return null;
  if (text.startsWith("No async subagent tasks")) return [];
  const [head, ...lines] = text.split("\n");
  if (!/tracked task/.test(head)) return null;
  const entries: TaskListEntry[] = [];
  for (const line of lines) {
    const match = TASK_LIST_LINE.exec(line.trim());
    const status = match ? asyncTaskRunStatus(match[3]) : null;
    if (!match || !status) return null;
    entries.push({ taskId: match[1], agent: match[2], status });
  }
  return entries;
};

// ---------------------------------------------------------------------------
// Meta (the muted note after the title)
// ---------------------------------------------------------------------------

const plural = (count: number, one: string, many = `${one}s`): string =>
  `${count} ${count === 1 ? one : many}`;

/** Short facts for the title row: line range, match counts, replacements. */
export const toolMeta = (
  name: string,
  args: unknown,
  result: string | undefined,
  serverId?: string,
): string | undefined => {
  const a = asToolArgs(args);
  if (isMcpTool(name, serverId)) return mcpMeta(name, a, result);
  switch (name) {
    case "read_file": {
      const file = parseNumberedFile(result);
      return file ? `lines ${file.first}–${file.last}` : undefined;
    }
    case "ls": {
      const list = parsePathList(result);
      return list ? plural(list.paths.length, "item") : undefined;
    }
    case "glob": {
      const list = parsePathList(result);
      return list ? plural(list.paths.length, "file") : undefined;
    }
    case "grep": {
      const grep = parseGrep(result, a?.output_mode);
      if (!grep) return undefined;
      if (grep.mode === "files") return plural(grep.files.length, "file");
      if (grep.mode === "count") return plural(grep.counts.reduce((n, c) => n + c.count, 0), "match", "matches");
      return plural(grep.files.reduce((n, f) => n + f.lines.length, 0), "match", "matches");
    }
    case "edit_file":
      return a?.replace_all === true ? "all occurrences" : undefined;
    case "execute": {
      const out = parseCommandOutput(result);
      return out?.exitCode !== undefined ? `exit ${out.exitCode}` : undefined;
    }
    case "search_past_conversations": {
      const hits = parsePastChats(result);
      return hits ? plural(hits.length, "match", "matches") : undefined;
    }
    case "check_async_task": {
      const check = parseTaskCheck(result);
      return check ? STATUS_LABELS[check.status] : undefined;
    }
    case "list_async_tasks": {
      const list = parseTaskList(result);
      return list ? plural(list.length, "task") : undefined;
    }
    case "reply_to_comment":
    case "add_comment":
      return parseCommentToolResult(result)?.ok === false ? "not posted" : undefined;
    case LIST_COMMENTS_TOOL:
      return commentListingRefusal(result) ? "not read" : undefined;
    case "view_image": {
      const region = asToolArgs(a?.region);
      return region && typeof region.width === "number" && typeof region.height === "number"
        ? `region ${region.width}×${region.height}`
        : undefined;
    }
    default:
      return undefined;
  }
};

// ---------------------------------------------------------------------------
// Syntax highlighting by file extension
// ---------------------------------------------------------------------------

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  json: "json",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sh: "bash",
  bash: "bash",
  sql: "sql",
  html: "html",
  css: "css",
  csv: "csv",
  xml: "xml",
  dockerfile: "dockerfile",
};

/** Highlighter language for a path; unknown types render as plain text. */
export const languageForPath = (path: string): BundledLanguage => {
  const name = basename(path).toLowerCase();
  const ext = name === "dockerfile" ? "dockerfile" : name.slice(name.lastIndexOf(".") + 1);
  // CodeBlock falls back to plain text for anything its highlighter lacks.
  return (LANGUAGE_BY_EXTENSION[ext] ?? "text") as BundledLanguage;
};
