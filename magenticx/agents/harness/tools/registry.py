"""Native-tool registry — the in-code catalog of platform (native) tools.

Native tools are Python tools that ship in the image (as opposed to MCP tools,
which arrive as a live manifest from the gateway). This registry is their single
source of truth: each tool registers its **metadata** (description, the AG-UI
events it emits, whether it is HITL-gated by default) plus a **builder** that
produces the per-run, context-bound LangChain tool. It exists so that

* a declarative ``agent.yaml`` can select a native tool **by name**
  (``{native: <name>}``) — resolved via :func:`resolve_native_tool`;
* the platform can present a **read-only catalog** of what tools exist
  (:func:`native_catalog`) without duplicating anything into YAML;
* the ``AgentSpec`` loader can validate ``{native: ...}`` refs
  (:func:`is_known_native_tool`);
* ``DeepAgent._builtin_tools`` can attach the always-on builtins from one place
  (:func:`build_auto_attach_tools`).

See ``docs/draft/platform-restructure-change-plan.md`` §5. Native tools are
platform-owned: adding one is a code change here, never a user upload.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from harness.conversation_files import ConversationFiles
from harness.tools.ask_user import build_ask_user_tool
from harness.tools.builtins import builtin_hitl_defaults
from harness.tools.canvas_comments import (
    ADD_TOOL_NAME,
    LIST_TOOL_NAME,
    REPLY_TOOL_NAME,
    CommentWriteBudget,
    build_add_comment_tool,
    build_list_comments_tool,
    build_reply_to_comment_tool,
)
from harness.tools.charts import build_render_chart_tool
from harness.tools.create_skill import build_create_skill_tool
from harness.tools.forget import build_forget_tool
from harness.tools.memory_search import build_memory_search_tool
from harness.tools.present_artifact import build_present_artifact_tool
from harness.tools.remember import build_remember_tool
from harness.tools.view_image import build_view_image_tool


@dataclass(frozen=True)
class NativeToolContext:
    """Per-run binding a native-tool builder needs. Assembled from the agent's
    ``self.context`` at build time; safe to hold identity because every request
    builds its own agent instance (nothing shared across users)."""

    user_id: str
    agent_slug: str
    conversation_id: Optional[str]
    use_memory: bool = True
    search_past_convs: bool = False
    # Provenance for anything this run writes durably. `run_id`/`thread_id` come
    # straight from the run config; `trust_level` is decided by the agent, which
    # is the only layer that can see the whole tool set (a builder cannot).
    run_id: Optional[str] = None
    thread_id: Optional[str] = None
    trust_level: str = "unknown"
    # The run's conversation files (plan 36), shared with its filesystem
    # mounts. None when the run has no conversation.
    files: ConversationFiles | None = None
    # Someone is there to answer: a chat turn. A scheduled task's run is not
    # (nobody would ever resume it), so it never gets `ask_user`.
    interactive: bool = True
    # The background task this run is (plan 41), or None for a chat turn. A
    # task never asks the user anything: only the orchestrator may pause on a
    # question, so ``ask_user`` is not even attached to a task run.
    async_task_id: Optional[str] = None
    # The run's conversation has at least one canvas document (plan 44 v2):
    # probed by the agent at build time from the same version rows the
    # per-turn canvas note reads. Gates the comment tools.
    has_canvas_documents: bool = False
    # The run's comment-write budget, shared by the two comment writes. The
    # agent instance owns it (one per run), so every context it builds — the
    # builtins and any `{native: …}` reference — counts against the same cap.
    comment_writes: Optional[CommentWriteBudget] = None

    @property
    def comments_available(self) -> bool:
        """The comment tools' gate: a user's conversation with canvas documents, not a background task."""
        return bool(
            self.user_id and self.conversation_id and self.has_canvas_documents
            and self.comment_writes is not None and not self.async_task_id
        )


@dataclass(frozen=True)
class NativeToolDef:
    """A registered native tool: metadata + a context-bound builder.

    ``builder(ctx)`` returns the LangChain tool, or ``None`` when this run does
    not satisfy the tool's gate (e.g. ``remember`` when memory is off). Reserved
    deepagents names (``write_todos``, ``read_file`` …) are NOT registered here —
    those are provided by deepagents itself.
    """

    name: str
    description: str
    builder: Callable[[NativeToolContext], Optional[Any]]
    emits: tuple[str, ...] = ()
    hitl_default: bool = False
    # Auto-attach tools are given to every deep agent (subject to their gate),
    # not selected in `agent.yaml`. Non-auto tools are opt-in via `{native: ...}`.
    auto_attach: bool = False


# Registration order is preserved (dict insertion order) and is the order
# auto-attach tools are appended to a deep agent — kept identical to the old
# hand-written `_builtin_tools` (remember → search → present_artifact).
NATIVE_TOOLS: dict[str, NativeToolDef] = {}


def register_native_tool(defn: NativeToolDef) -> NativeToolDef:
    """Register a native tool. Raises on a duplicate name (fail-closed)."""
    if defn.name in NATIVE_TOOLS:
        raise ValueError(f"Native tool {defn.name!r} is already registered.")
    NATIVE_TOOLS[defn.name] = defn
    return defn


# --- Built-in native tools --------------------------------------------------
# Gate logic mirrors the previous DeepAgent._builtin_tools exactly:
#   remember               → attached when use_memory is on
#   forget                 → same gate; HITL-gated (a delete has no undo)
#   search_past_conversations → attached when the user opted into search_past_convs
#   present_artifact       → attached whenever there is a conversation to point into
#   view_image             → same gate; reads from input/ and output/
#   create_skill           → always attached (HITL-gated; writes to the user's pool)
#   render_chart           → attached whenever there is a conversation to draw into
#   ask_user               → attached to an interactive conversation run (never
#                            gated; refuses inside a sub-agent)
#   list_comments, reply_to_comment, add_comment
#                          → attached when the conversation has a canvas document
#                            and the run is not a background task (not gated;
#                            the two writes are bounded to 10 per run instead,
#                            the read is not counted). There is no resolve
#                            tool: the user resolves a thread.

register_native_tool(
    NativeToolDef(
        name="remember",
        description="Save a durable fact to this (user, agent)'s long-term memory.",
        auto_attach=True,
        builder=lambda ctx: (
            build_remember_tool(
                user_id=ctx.user_id,
                agent_slug=ctx.agent_slug,
                conversation_id=ctx.conversation_id,
                run_id=ctx.run_id,
                thread_id=ctx.thread_id,
                trust_level=ctx.trust_level,
            )
            if ctx.use_memory
            else None
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name="forget",
        description="Delete one memory from this (user, agent)'s long-term memory.",
        auto_attach=True,
        hitl_default=True,
        builder=lambda ctx: (
            build_forget_tool(user_id=ctx.user_id, agent_slug=ctx.agent_slug)
            if ctx.use_memory
            else None
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name="search_past_conversations",
        description="Semantically search the user's earlier conversations (opt-in).",
        auto_attach=True,
        builder=lambda ctx: (
            build_memory_search_tool(
                user_id=ctx.user_id,
                conversation_id=ctx.conversation_id,
            )
            if ctx.search_past_convs
            else None
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name="render_chart",
        description="Draw a chart inline in the reply from data the agent supplies.",
        auto_attach=True,
        # Not HITL-gated: it draws, it does not write. Nothing leaves the run —
        # the payload is projected to the plotted fields and rendered in the
        # timeline, so there is no side effect for a human to approve.
        builder=lambda ctx: (
            build_render_chart_tool(
                agent_slug=ctx.agent_slug,
                conversation_id=ctx.conversation_id,
            )
            if ctx.conversation_id
            else None
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name="view_image",
        description="Look at an image from the conversation's input/ or output/ folder.",
        auto_attach=True,
        builder=lambda ctx: build_view_image_tool(files=ctx.files) if ctx.files else None,
    )
)

register_native_tool(
    NativeToolDef(
        name="present_artifact",
        description="Hand a finished output/ file to the user as a document card in the reply.",
        auto_attach=True,
        builder=lambda ctx: build_present_artifact_tool(files=ctx.files) if ctx.files else None,
    )
)

register_native_tool(
    NativeToolDef(
        name="create_skill",
        description="Author a reusable skill into the user's pool and enable it for this agent.",
        auto_attach=True,
        # HITL by default: this writes a new folder into the user's own
        # workspace, and the platform's stance on agent-initiated writes is
        # fail-closed. Relaxing this later is one flag; discovering it should
        # not have been open is not recoverable.
        hitl_default=True,
        builder=lambda ctx: build_create_skill_tool(
            user_id=ctx.user_id,
            agent_slug=ctx.agent_slug,
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name="ask_user",
        description="Ask the user 1-3 clarifying questions with suggested answers, pausing until they reply.",
        auto_attach=True,
        # The call is itself the human-in-the-loop pause, so it is never gated
        # (see `BuiltinTool.gateable`). It needs someone to answer: a
        # conversation, and a run the user is actually watching.
        builder=lambda ctx: (
            build_ask_user_tool() if ctx.conversation_id and ctx.interactive and not ctx.async_task_id else None
        ),
    )
)


# The canvas comment tools (plan 44 v2). Not HITL-gated: a comment is not a
# document edit and nothing leaves the conversation; the per-run write budget
# bounds the writes instead. The `comments_available` gate guarantees the
# budget and the conversation are there. The read comes first: it is what the
# agent reaches for before answering a thread it cannot see in the note.
register_native_tool(
    NativeToolDef(
        name=LIST_TOOL_NAME,
        description="Read the comment threads (open, resolved or all) on the conversation's canvas documents.",
        auto_attach=True,
        # Read-only, so not counted against the write budget; it shares the
        # writes' gate so the three always come and go together.
        builder=lambda ctx: (
            build_list_comments_tool(user_id=ctx.user_id, conversation_id=str(ctx.conversation_id))
            if ctx.comments_available
            else None
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name=REPLY_TOOL_NAME,
        description="Reply in a comment thread on one of the conversation's canvas documents.",
        auto_attach=True,
        builder=lambda ctx: (
            build_reply_to_comment_tool(user_id=ctx.user_id, conversation_id=str(ctx.conversation_id),
                                        budget=ctx.comment_writes)
            if ctx.comments_available and ctx.comment_writes is not None
            else None
        ),
    )
)

register_native_tool(
    NativeToolDef(
        name=ADD_TOOL_NAME,
        description="Leave a comment (an assumption or a question) on a passage of a canvas document.",
        auto_attach=True,
        builder=lambda ctx: (
            build_add_comment_tool(user_id=ctx.user_id, conversation_id=str(ctx.conversation_id),
                                   run_id=ctx.run_id, budget=ctx.comment_writes)
            if ctx.comments_available and ctx.comment_writes is not None
            else None
        ),
    )
)


# --- Public API -------------------------------------------------------------
def is_known_native_tool(name: str) -> bool:
    """Whether ``name`` is a registered native tool (used to validate specs)."""
    return name in NATIVE_TOOLS


def resolve_native_tool(name: str, ctx: NativeToolContext) -> Optional[Any]:
    """Build a native tool selected by an agent (``{native: name}``).

    Returns the bound tool, or ``None`` when unknown or gated off this run."""
    defn = NATIVE_TOOLS.get(name)
    return defn.builder(ctx) if defn is not None else None


def build_auto_attach_tools(ctx: NativeToolContext) -> list[Any]:
    """The always-on builtins every deep agent gets, in registration order,
    each subject to its own gate. ``DeepAgent._builtin_tools`` delegates here."""
    tools: list[Any] = []
    for defn in NATIVE_TOOLS.values():
        if not defn.auto_attach:
            continue
        tool = defn.builder(ctx)
        if tool is not None:
            tools.append(tool)
    return tools


def native_hitl_defaults() -> dict[str, bool]:
    """Approval gates every deep agent starts with.

    Delegates to the builtin roster so the defaults and the catalog cannot
    disagree; the framework tools have no entry here at all.
    """
    return builtin_hitl_defaults()


def native_catalog() -> list[dict[str, Any]]:
    """Read-only listing of every native tool for the inspection UI / catalog.

    Metadata only — never builders. Paired with the live MCP manifest by the
    bridge to form the full tool catalog."""
    return [
        {
            "name": d.name,
            "description": d.description,
            "emits": list(d.emits),
            "hitlDefault": d.hitl_default,
            "autoAttach": d.auto_attach,
            "source": "native",
        }
        for d in NATIVE_TOOLS.values()
    ]


__all__ = [
    "NATIVE_TOOLS",
    "NativeToolContext",
    "NativeToolDef",
    "build_auto_attach_tools",
    "is_known_native_tool",
    "native_catalog",
    "register_native_tool",
    "resolve_native_tool",
]
