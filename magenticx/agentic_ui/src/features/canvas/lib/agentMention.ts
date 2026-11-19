/**
 * `@agent` in a comment (plan 44 v2): a comment that mentions the agent asks
 * it to act on the thread's passage. The token is `@agent` as a word, in any
 * case — not inside an e-mail address (`me@agent.io`) and not the start of a
 * longer word (`@agents`).
 *
 * Pure text helpers, shared by the composer (the styled token, the "@"
 * suggestion), the cards (the token styled in shown bodies) and the send (the
 * instruction is the comment without the token).
 */

/** The token, as the composer inserts it. */
export const AGENT_MENTION = "@agent";

/** The `@agent` token's look, in shown bodies and behind the composer's text. */
export const MENTION_TOKEN = "rounded-[5px] bg-primary/12 text-primary";

/** What the agent is asked when the comment is only the token. */
export const EMPTY_MENTION_INSTRUCTION = "Address this comment.";

/** `@agent` as a word: not after a word character or `@`, not before a word character. */
const MENTION = /(?<![\w@])@agent(?![\w-])/gi;

/** Whether `body` mentions the agent. */
export function hasAgentMention(body: string): boolean {
  MENTION.lastIndex = 0;
  const found = MENTION.test(body);
  MENTION.lastIndex = 0;
  return found;
}

/** The instruction an `@agent` comment sends: the comment without the token, trimmed. */
export function mentionInstruction(body: string): string {
  const text = body
    .replace(MENTION, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
  return text || EMPTY_MENTION_INSTRUCTION;
}

/** A body cut into plain text and `@agent` tokens, in order (for styling the token). */
export function splitAgentMentions(body: string): { text: string; mention: boolean }[] {
  const parts: { text: string; mention: boolean }[] = [];
  let last = 0;
  for (const match of body.matchAll(MENTION)) {
    const at = match.index ?? 0;
    if (at > last) parts.push({ text: body.slice(last, at), mention: false });
    parts.push({ text: match[0], mention: true });
    last = at + match[0].length;
  }
  if (last < body.length) parts.push({ text: body.slice(last), mention: false });
  return parts;
}

/**
 * The "@…" being typed at the caret that `@agent` would complete: where it
 * starts and what is typed after the "@". Null when the caret is not right
 * after an "@" + the start of "agent" at a word's start (the suggestion then
 * stays closed), or when the token is already whole.
 */
export function mentionQuery(text: string, caret: number): { start: number; typed: string } | null {
  const before = text.slice(0, caret);
  const match = /(^|[^\w@])@([a-z]*)$/i.exec(before);
  if (!match) return null;
  const typed = match[2];
  const word = AGENT_MENTION.slice(1);
  if (typed.length >= word.length || !word.startsWith(typed.toLowerCase())) return null;
  // The next character must not continue the word (completing mid-word is not a mention).
  if (/^[\w@]/.test(text.slice(caret))) return null;
  return { start: caret - typed.length - 1, typed };
}

/**
 * A popover's Esc (Radix hears it first, on the document): kept from closing
 * the popover while the composer inside offers "@agent" — that Esc closes
 * the suggestion only.
 */
export function keepOpenForMention(event: KeyboardEvent): void {
  const target = event.target;
  if (target instanceof Element && target.closest("[data-mention-open]")) event.preventDefault();
}

/** `text` with the "@…" at `query` completed to `@agent ` and where the caret goes. */
export function completeMention(
  text: string,
  query: { start: number; typed: string },
): { text: string; caret: number } {
  const end = query.start + 1 + query.typed.length;
  const after = text.slice(end);
  const insert = after.startsWith(" ") ? AGENT_MENTION : `${AGENT_MENTION} `;
  const next = text.slice(0, query.start) + insert + after;
  return { text: next, caret: query.start + AGENT_MENTION.length + 1 };
}
