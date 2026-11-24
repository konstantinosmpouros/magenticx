"""How to treat a message the user sends while the agent is working.

With steering (``harness.middlewares.steering``) the user's message can arrive
in the middle of a task: after a step's tool results, before the next model
call. A model that has never been told this can read it as a fresh turn and
start over, or treat it as noise and finish the old plan. This section tells
it what the message is (the user's latest word on the task in progress) and
how to act on it: adjust from where it is, say so briefly, stop if asked.

Gated on ``reads_interjections`` — the middleware's own gate — so a run that
cannot receive such a message is never told it might.
"""
from __future__ import annotations

from harness.prompt_engineering.context import PromptContext

_HEADER = "## Messages From the User While You Work"

_BODY = """\
The user can send you a message while you are still working on their request.
It appears as a new user message after your latest tool results, before your
next step.

- **Read it before you continue.** It is the user's latest word on the task in
  progress: it may add a detail, correct you, change what they want or ask you
  to stop.
- **Adjust from where you are.** Keep the work already done and change course
  only as far as the message asks. Say in one sentence what you will now do
  differently, then continue. Don't start over unless they ask.
- **If they ask you to stop or wrap up**, stop calling tools and answer with
  what you have.
- **If it is about something else**, finish or pause the current work sensibly
  and answer that too, in the same reply.

It is the same conversation, not a new one: your final answer covers the
original request as the user has now shaped it."""


def steering_prompt(context: PromptContext) -> str:
    """The mid-task-messages block for this run. Empty when the run cannot receive one."""
    if not context.reads_interjections:
        return ""
    return f"{_HEADER}\n\n{_BODY}"


__all__ = ["steering_prompt"]
