"""The prebuilt-tool roster: every tool a deep agent has that is not an MCP tool.

Two origins, one roster. The **framework** tools are constructed inside
``create_deep_agent``, downstream of the tool list we hand it, so we never hold
them and cannot filter them — only ``interrupt_on`` reaches them. The **native**
tools are ours (``harness/tools/registry.py`` owns their builders), but the
Agents tab is not where their presence is decided either.

That is why a builtin's approval is configurable and its enablement never is —
with one exception: a tool whose call *is* the human step (``ask_user``) is
never gated, since an approval in front of a question would ask twice.

Descriptions for native tools are not duplicated here — the catalog reads them
from the registry, which owns them.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any


class Availability(str, Enum):
    """What a builtin's presence in a given run depends on."""

    ALWAYS = "always"
    USE_MEMORY = "use_memory"
    SEARCH_PAST_CONVS = "search_past_convs"
    CONVERSATION = "conversation"
    SANDBOX = "sandbox"


_UNAVAILABLE_REASON: dict[Availability, str] = {
    Availability.USE_MEMORY: "Memory is off in Personalization.",
    Availability.SEARCH_PAST_CONVS: "Past-conversation search is off in Personalization.",
    Availability.CONVERSATION: "Needs a conversation.",
    Availability.SANDBOX: "Sandboxed execution is disabled on this deployment.",
}


@dataclass(frozen=True)
class BuiltinTool:
    """One prebuilt tool: where it belongs, how it gates, when it exists."""

    name: str
    group: str
    description: str = ""
    hitl_default: bool = False
    #: Approval cannot be turned off by anyone. Enforced last in the merge.
    locked: bool = False
    #: Approval can never be turned on: the call is itself a pause for the user.
    #: Stripped after every layer of the merge, so no gate can reach it.
    gateable: bool = True
    availability: Availability = Availability.ALWAYS


#: deepagents' tool that starts a background sub-agent (plan 41) — the only
#: way to delegate, and the delegation gate.
START_ASYNC_TASK_TOOL_NAME = "start_async_task"

#: Deprecated gate keys a stored agent definition may still use, and the key
#: they are rewritten to on load (``AgentSpec``): ``task`` was the blocking
#: delegation tool, removed at plan 41's cut-over. Stored per-user preferences
#: were migrated by the bridge (migration ``0046_async_tasks``); definitions are
#: rewritten when read, so a gate an author set on ``task`` still gates.
DEPRECATED_GATE_KEYS: dict[str, str] = {"task": START_ASYNC_TASK_TOOL_NAME}

#: deepagents' sandbox tool. Named once so the approval merge can force its
#: gate by name (``gates.resolve_interrupt_on``) and validation can refuse a
#: definition that tries to clear it.
EXECUTE_TOOL_NAME = "execute"

BUILTIN_TOOLS: tuple[BuiltinTool, ...] = (
    BuiltinTool("write_todos", "Planning", "Track a structured task list for the run."),
    BuiltinTool("ls", "Filesystem", "List a directory."),
    BuiltinTool("read_file", "Filesystem", "Read a file, including images and PDFs."),
    BuiltinTool("glob", "Filesystem", "Find files by pattern."),
    BuiltinTool("grep", "Filesystem", "Search text across files."),
    BuiltinTool("write_file", "Filesystem", "Create a file in the conversation workspace.", hitl_default=True),
    BuiltinTool("edit_file", "Filesystem", "Replace text in an existing file.", hitl_default=True),
    BuiltinTool(
        EXECUTE_TOOL_NAME,
        "Execution",
        "Run a shell command in an isolated sandbox (no network; the conversation's "
        "input/ read-only, output/ writable). Always asks for approval.",
        hitl_default=True,
        locked=True,
        availability=Availability.SANDBOX,
    ),
    # deepagents' async sub-agent tools (plan 41): every deep agent has them,
    # for its general-purpose sub-agent at least. Starting a task is the
    # delegation gate; following one up is driven by the user through the
    # orchestrator, so those are not gated by default.
    BuiltinTool(
        START_ASYNC_TASK_TOOL_NAME,
        "Delegation",
        "Start a sub-agent in the background; it returns at once.",
        hitl_default=True,
    ),
    BuiltinTool("check_async_task", "Delegation", "Check a background sub-agent's status and result."),
    BuiltinTool("update_async_task", "Delegation", "Send a background sub-agent a follow-up instruction."),
    BuiltinTool("cancel_async_task", "Delegation", "Stop a background sub-agent."),
    BuiltinTool("list_async_tasks", "Delegation", "List the background sub-agents and their status."),
    BuiltinTool("remember", "Memory", availability=Availability.USE_MEMORY),
    BuiltinTool("forget", "Memory", hitl_default=True, availability=Availability.USE_MEMORY),
    BuiltinTool(
        "search_past_conversations", "Memory", availability=Availability.SEARCH_PAST_CONVS
    ),
    BuiltinTool("view_image", "Filesystem", availability=Availability.CONVERSATION),
    BuiltinTool("render_chart", "Output"),
    BuiltinTool("present_artifact", "Output", availability=Availability.CONVERSATION),
    BuiltinTool("create_skill", "Skills", hitl_default=True),
    BuiltinTool("ask_user", "Interaction", gateable=False, availability=Availability.CONVERSATION),
    # The canvas comment tools (plan 44 v2): attached only when the
    # conversation has a canvas document (a per-run fact the catalog cannot
    # know, so it lists them under the conversation gate). Not gated by
    # default — they only touch comments, and a per-run cap bounds them.
    # There is no resolve tool: resolving a thread is the user's call.
    # `list_comments` is the one read (open / resolved / all), never counted
    # against the write cap.
    BuiltinTool("list_comments", "Canvas", availability=Availability.CONVERSATION),
    BuiltinTool("reply_to_comment", "Canvas", availability=Availability.CONVERSATION),
    BuiltinTool("add_comment", "Canvas", availability=Availability.CONVERSATION),
    # The user's pending suggestions (plan 44, Phase 4.6): accept or reject the
    # set, only when the user asks. Same gate as the comment tools; not gated
    # (it runs on the user's request) and not counted against the comment cap.
    BuiltinTool("review_suggestions", "Canvas", availability=Availability.CONVERSATION),
)

BUILTIN_BY_NAME: dict[str, BuiltinTool] = {t.name: t for t in BUILTIN_TOOLS}


def is_builtin(name: str) -> bool:
    """Whether ``name`` is a prebuilt tool rather than an MCP one."""
    return name in BUILTIN_BY_NAME


def builtin_hitl_defaults() -> dict[str, bool]:
    """Approval gates every deep agent starts with, before any user choice."""
    return {t.name: True for t in BUILTIN_TOOLS if t.hitl_default or t.locked}


def locked_gates() -> dict[str, bool]:
    """Gates no layer may clear. Merged last, after the user's choices."""
    return {t.name: True for t in BUILTIN_TOOLS if t.locked}


#: Tools only the main agent has: sub-agents are built without them
#: (``deep_agent._without_ask_user``) — a question goes to the person, and only
#: the main agent talks to them.
MAIN_ONLY_TOOLS: frozenset[str] = frozenset({"ask_user"})


def builtin_tool_catalog(*, sandbox_enabled: bool = False) -> list[dict[str, Any]]:
    """Every prebuilt tool as the agent builder lists it (``GET /builtin-tools``):
    what it does, its group, and how its approval behaves.

    A sandbox-only tool (``execute``) is listed only where sandboxed execution
    is active, so the builder never offers a gate for a tool no run can have.
    It stays in :data:`BUILTIN_BY_NAME` either way — that roster is also the
    reserved-name list MCP tools are filtered against."""
    return [
        {
            "name": t.name,
            "description": t.description,
            "group": t.group,
            "hitlDefault": t.hitl_default or t.locked,
            "locked": t.locked,
            "gateable": t.gateable,
            "mainOnly": t.name in MAIN_ONLY_TOOLS,
        }
        for t in BUILTIN_TOOLS
        if t.availability is not Availability.SANDBOX or sandbox_enabled
    ]


def ungateable_tools() -> frozenset[str]:
    """Tools no layer may gate. Removed after the merge, locked gates included."""
    return frozenset(t.name for t in BUILTIN_TOOLS if not t.gateable)


def resolve_availability(
    tool: BuiltinTool,
    *,
    use_memory: bool,
    search_past_convs: bool,
    has_conversation: bool,
    sandbox_enabled: bool,
) -> tuple[bool, str | None]:
    """Whether this run actually has ``tool``, and why not when it does not."""
    present = {
        Availability.ALWAYS: True,
        Availability.USE_MEMORY: use_memory,
        Availability.SEARCH_PAST_CONVS: search_past_convs,
        Availability.CONVERSATION: has_conversation,
        Availability.SANDBOX: sandbox_enabled,
    }[tool.availability]
    return present, None if present else _UNAVAILABLE_REASON[tool.availability]


__all__ = [
    "BUILTIN_BY_NAME",
    "BUILTIN_TOOLS",
    "MAIN_ONLY_TOOLS",
    "Availability",
    "BuiltinTool",
    "DEPRECATED_GATE_KEYS",
    "EXECUTE_TOOL_NAME",
    "START_ASYNC_TASK_TOOL_NAME",
    "builtin_hitl_defaults",
    "builtin_tool_catalog",
    "is_builtin",
    "locked_gates",
    "resolve_availability",
    "ungateable_tools",
]
