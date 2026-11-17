"""Sub-agents with sub-agents of their own: the definition and the build.

Every sub-agent is a background task (plan 41): each level of the tree gets the
async task tools over the level below it, and a task run builds its own node
of the tree from its path. Pinned here:

* **the definition** — at most ``MAX_SUBAGENT_DEPTH`` levels, unique sibling
  names, no name repeated below itself, every node a spec (no compiled
  sub-agent), and tools only ever narrowing on the way down (``AgentSpec`` for
  YAML and user agents, ``validate_subagent_tree`` for agents written in code);
* **the build** — every node carries the platform middleware and the base
  stack (planning, filesystem with the workspace's rules, summarization), the
  run's approval gates (which a spec can add to but never clear a locked one
  from), task tools only over its own children, and never ``ask_user``;
* **the YAML agent** declares the same tree.
"""
from __future__ import annotations

import importlib
from typing import Any

import pytest
from deepagents.backends import StateBackend
from deepagents.middleware.filesystem import FilesystemMiddleware
from langchain.agents.middleware import TodoListMiddleware
from langchain_core.tools import tool
from pydantic import ValidationError


@tool
def search(query: str) -> str:
    """Search the web."""
    return query


@tool
def lookup(claim: str) -> str:
    """Look a claim up."""
    return claim


@tool
def ask_user(question: str) -> str:
    """Ask the user (stands in for the real tool: only its name matters here)."""
    return question


MODEL = "openai:gpt-4.1-mini"


@pytest.fixture
def spec_module(agents_service):
    return importlib.import_module("harness.abstractions.agent_spec")


@pytest.fixture
def tree_module(agents_service):
    return importlib.import_module("harness.abstractions.subagent_tree")


@pytest.fixture
def deep_agent_module(agents_service):
    return importlib.import_module("harness.abstractions.deep_agent")


@pytest.fixture
def middlewares(agents_service):
    return importlib.import_module("harness.middlewares")


def _agent_spec(spec_module, *, tools=(), subagents=()):
    return spec_module.AgentSpec.model_validate(
        {
            "id": "nested-demo-v1",
            "slug": "nested-demo",
            "name": "Nested demo",
            "version": "1.0.0",
            "type": "deep_agent",
            "prompt": "You answer questions.",
            "model": {"main": MODEL},
            "tools": list(tools),
            "subagents": list(subagents),
        }
    )


def _sa(name: str, *children: dict, tools=None) -> dict:
    out: dict[str, Any] = {"name": name, "description": f"The {name}.", "prompt": f"You are the {name}."}
    if tools is not None:
        out["tools"] = tools
    if children:
        out["subagents"] = list(children)
    return out


NATIVE_REMEMBER = {"native": "remember"}
NATIVE_PRESENT = {"native": "present_artifact"}


# ---------------------------------------------------------------------------
# The definition (YAML / user agents)
# ---------------------------------------------------------------------------
def test_three_levels_below_the_agent_are_allowed(spec_module):
    spec = _agent_spec(spec_module, subagents=[_sa("researcher", _sa("fact-checker", _sa("source-verifier")))])
    assert [path for path, _ in spec.walk_subagents()] == [
        ("researcher",),
        ("researcher", "fact-checker"),
        ("researcher", "fact-checker", "source-verifier"),
    ]
    assert spec_module.MAX_SUBAGENT_DEPTH == 3


def test_a_fourth_level_is_refused(spec_module):
    deep = _sa("a", _sa("b", _sa("c", _sa("d"))))
    with pytest.raises(ValidationError, match="'a > b > c > d' is 4 levels below the agent; at most 3"):
        _agent_spec(spec_module, subagents=[deep])


def test_siblings_need_distinct_names(spec_module):
    with pytest.raises(ValidationError, match="under 'researcher' share a name: checker"):
        _agent_spec(spec_module, subagents=[_sa("researcher", _sa("checker"), _sa("checker"))])
    with pytest.raises(ValidationError, match="of the agent share a name: researcher"):
        _agent_spec(spec_module, subagents=[_sa("researcher"), _sa("researcher")])


def test_a_name_cannot_repeat_below_itself(spec_module):
    with pytest.raises(ValidationError, match="'researcher > checker > researcher' repeats a name above it"):
        _agent_spec(spec_module, subagents=[_sa("researcher", _sa("checker", _sa("researcher")))])
    # The same name in two branches is not a loop.
    spec = _agent_spec(spec_module, subagents=[_sa("a", _sa("checker")), _sa("b", _sa("checker"))])
    assert len(list(spec.walk_subagents())) == 4


def test_tools_only_narrow_on_the_way_down(spec_module):
    declared = [NATIVE_REMEMBER, NATIVE_PRESENT]
    # Inheriting at every level, or narrowing step by step, is fine.
    _agent_spec(spec_module, tools=declared, subagents=[_sa("r", _sa("c", tools=[NATIVE_PRESENT]))])
    _agent_spec(
        spec_module,
        tools=declared,
        subagents=[_sa("r", _sa("c", tools=[NATIVE_PRESENT]), tools=[NATIVE_PRESENT, NATIVE_REMEMBER])],
    )
    # A child cannot take back what its parent gave up.
    with pytest.raises(ValidationError, match="'r > c' lists tools sub-agent 'r' does not have: remember"):
        _agent_spec(
            spec_module,
            tools=declared,
            subagents=[_sa("r", _sa("c", tools=[NATIVE_REMEMBER]), tools=[NATIVE_PRESENT])],
        )
    # Nor anything the agent itself was never given.
    with pytest.raises(ValidationError, match="lists tools sub-agent 'r' does not have: create_skill"):
        _agent_spec(spec_module, tools=declared, subagents=[_sa("r", _sa("c", tools=[{"native": "create_skill"}]))])


def test_references_are_collected_at_every_depth(spec_module):
    inner = {**_sa("c", tools=[NATIVE_PRESENT]), "model": "openai:gpt-4o"}
    spec = _agent_spec(spec_module, tools=[NATIVE_PRESENT], subagents=[_sa("r", inner)])
    assert spec.all_model_ids() == sorted({MODEL, "openai:gpt-4o"})
    assert spec.native_tool_names() == ["present_artifact"]


def test_a_user_agent_prompt_reference_is_checked_at_every_depth(agents_service, spec_module):
    user_agents = importlib.import_module("harness.abstractions.user_agents")
    schema = importlib.import_module("schema")
    payload = _agent_spec(
        spec_module,
        subagents=[{**_sa("researcher", {**_sa("checker"), "prompt": "./subagents/checker.md"}),
                    "prompt": "./subagents/researcher.md"}],
    ).model_dump()
    payload["prompt"] = "./AGENT.md"
    files = [schema.AgentFile(path="AGENT.md", content="x"), schema.AgentFile(path="subagents/researcher.md", content="x")]
    monkey_models = {MODEL: importlib.import_module("core.settings").ModelInfo()}
    original = user_agents.settings.registry.allowed_agent_models
    user_agents.settings.registry.allowed_agent_models = monkey_models
    try:
        spec, errors = user_agents.validate_write(
            "u1", payload, files, reserved_slugs=frozenset(), known_skills=frozenset()
        )
    finally:
        user_agents.settings.registry.allowed_agent_models = original
    assert spec is None
    assert errors == [
        "The sub-agent 'researcher > checker' prompt points at 'subagents/checker.md', "
        "which is not among the uploaded files."
    ]


def test_a_user_agent_prompt_is_at_most_64_kib_at_every_depth(agents_service, spec_module):
    user_agents = importlib.import_module("harness.abstractions.user_agents")
    schema = importlib.import_module("schema")
    payload = _agent_spec(
        spec_module, subagents=[{**_sa("researcher"), "prompt": "./subagents/researcher.md"}],
    ).model_dump()
    payload["prompt"] = "./AGENT.md"
    files = [
        schema.AgentFile(path="AGENT.md", content="x" * (64 * 1024)),
        schema.AgentFile(path="subagents/researcher.md", content="x" * (64 * 1024 + 1)),
        schema.AgentFile(path="guides/long.md", content="x" * (200 * 1024)),
    ]
    original = user_agents.settings.registry.allowed_agent_models
    user_agents.settings.registry.allowed_agent_models = {MODEL: importlib.import_module("core.settings").ModelInfo()}
    try:
        spec, errors = user_agents.validate_write(
            "u1", payload, files, reserved_slugs=frozenset(), known_skills=frozenset()
        )
    finally:
        user_agents.settings.registry.allowed_agent_models = original
    assert spec is None
    assert errors == [
        "The sub-agent 'researcher' prompt is over 64 KiB; move reference material into a file of its own."
    ]


# ---------------------------------------------------------------------------
# The definition (agents written in code)
# ---------------------------------------------------------------------------
def test_a_code_defined_tree_is_held_to_the_same_rules(tree_module):
    sub = tree_module.subagent
    tree_module.validate_subagent_tree([sub("r", "d", "p", subagents=[sub("c", "d", "p", subagents=[sub("s", "d", "p")])])])
    with pytest.raises(ValueError, match="4 levels below the agent"):
        tree_module.validate_subagent_tree(
            [sub("a", "d", "p", subagents=[sub("b", "d", "p", subagents=[sub("c", "d", "p", subagents=[sub("d", "d", "p")])])])]
        )
    with pytest.raises(ValueError, match="repeats a name above it"):
        tree_module.validate_subagent_tree([sub("r", "d", "p", subagents=[sub("r", "d", "p")])])
    looped = sub("r", "d", "p")
    looped["subagents"] = [looped]
    with pytest.raises(ValueError, match="contains itself"):
        tree_module.validate_subagent_tree([looped])
    # A task run rebuilds its node from the tree, so every node is a spec.
    with pytest.raises(ValueError, match="cannot run as a background task"):
        tree_module.validate_subagent_tree([{"name": "x", "description": "d", "runnable": object()}])
    with pytest.raises(ValueError, match="cannot run as a background task"):
        tree_module.validate_subagent_tree([sub("r", "d", "p", subagents=[{"name": "c", "description": "d", "runnable": object()}])])
    with pytest.raises(ValueError, match="not a spec dict"):
        tree_module.validate_subagent_tree([object()])


# ---------------------------------------------------------------------------
# The build: the orchestrator, and each task node
# ---------------------------------------------------------------------------
class _Tasks:
    """Stands in for ``AsyncTaskMiddleware``: records the specs it was given."""

    def __init__(self, *, async_subagents):
        self.names = [spec["name"] for spec in async_subagents]


@pytest.fixture
def build(deep_agent_module, agents_service, monkeypatch):
    """Run the real build_deep_agent for the orchestrator (``path=()``) or one
    task node; capture what reaches create_deep_agent."""
    specs = importlib.import_module("harness.async_tasks.specs")
    token = importlib.import_module("harness.async_tasks.token")
    monkeypatch.setattr(deep_agent_module, "AsyncTaskMiddleware", _Tasks)

    class Bare(deep_agent_module.DeepAgent):
        name = "nested-build"

        def register_agent(self):
            return None

    def _build(subagents, path=(), *, interrupt_on=None):
        captured: dict[str, Any] = {}
        monkeypatch.setattr(deep_agent_module, "create_deep_agent", lambda **kwargs: captured.update(kwargs))
        agent = Bare(config={
            "context": {"user_id": "u", "conversation_id": "c", "run_id": "r", "use_memory": False},
            "run_config": {"configurable": {"thread_id": "branch"}},
        })
        monkeypatch.setattr(agent, "_build_composite_backend", lambda: StateBackend())
        monkeypatch.setattr(agent, "_builtin_tools", lambda: [])
        agent.tools = [search, lookup, ask_user]
        if path:
            agent.async_task_node = specs.TaskNode(
                task_id="task-1", depth=len(path), path=tuple(path), user_id="u", conversation_id="c",
                root_run_id="r", branch_thread_id="branch", agent_slug="nested-build",
                definition_version="v1", inherited=token.InheritedContext(),
            )
        agent.build_deep_agent(model=MODEL, middleware=[], interrupt_on=interrupt_on or {}, subagents=subagents)
        return captured

    return _build


def _children(built: dict) -> list[str] | None:
    """The sub-agents a built node can start, or None when it has no task tools."""
    tasks = [m for m in built["middleware"] if isinstance(m, _Tasks)]
    return tasks[0].names if tasks else None


def _tree(tree_module):
    sub = tree_module.subagent
    return [
        sub(
            "researcher", "Researches.", "You are the researcher.",
            subagents=[
                sub(
                    "fact-checker", "Checks facts.", "You are the fact-checker.", tools=[lookup, ask_user],
                    interrupt_on={"lookup": True, "execute": False},
                    subagents=[sub("source-verifier", "Finds sources.", "You are the source-verifier.")],
                ),
                sub("citer", "Cites.", "You are the citer.", tools=[]),
            ],
        ),
        sub("writer", "Writes.", "You are the writer."),
    ]


NODES = (
    ("general-purpose",),
    ("researcher",),
    ("writer",),
    ("researcher", "fact-checker"),
    ("researcher", "fact-checker", "source-verifier"),
    ("researcher", "citer"),
)


def _platform(middlewares) -> tuple[type, ...]:
    return (
        middlewares.ToolErrorMiddleware,
        middlewares.ToolMetricsMiddleware,
        middlewares.RetryOnRateLimitMiddleware,
        middlewares.UsageMetricsMiddleware,
    )


def test_the_orchestrator_starts_its_own_sub_agents_as_tasks(build, tree_module):
    built = build(_tree(tree_module))
    # deepagents builds no sub-agent itself: no blocking `task` tool anywhere.
    assert built["subagents"] is None
    # The general-purpose sub-agent is added, the nested ones are not its to start.
    assert _children(built) == ["general-purpose", "researcher", "writer"]


def test_every_node_carries_the_platform_middleware(build, tree_module, middlewares):
    for path in NODES:
        stack = build(_tree(tree_module), path)["middleware"]
        for cls in (*_platform(middlewares), TodoListMiddleware, FilesystemMiddleware):
            assert sum(isinstance(m, cls) for m in stack) == 1, (path, cls.__name__)
        assert any(type(m).__name__.endswith("SummarizationMiddleware") for m in stack), path


def test_only_a_node_with_sub_agents_gets_task_tools_and_only_over_its_own(build, tree_module):
    children = {path: _children(build(_tree(tree_module), path)) for path in NODES}
    assert children == {
        ("general-purpose",): None,
        ("researcher",): ["fact-checker", "citer"],
        ("writer",): None,
        ("researcher", "fact-checker"): ["source-verifier"],
        ("researcher", "fact-checker", "source-verifier"): None,
        ("researcher", "citer"): None,
    }


def test_no_node_at_any_depth_has_ask_user(build, tree_module):
    tools = {path: [t.name for t in build(_tree(tree_module), path)["tools"]] for path in NODES}
    for path, names in tools.items():
        assert "ask_user" not in names, path
    # Inheriting means the tools of the node above, minus ask_user; an explicit
    # list is kept (minus ask_user); an empty one stays empty.
    assert tools[("researcher",)] == ["search", "lookup"]
    assert tools[("researcher", "fact-checker")] == ["lookup"]
    assert tools[("researcher", "fact-checker", "source-verifier")] == ["lookup"]
    assert tools[("researcher", "citer")] == []


def test_gates_apply_at_every_depth_and_a_locked_one_cannot_be_cleared(build, tree_module):
    def gates(path):
        return build(_tree(tree_module), path, interrupt_on={"search": True})["interrupt_on"]

    checker, verifier = gates(("researcher", "fact-checker")), gates(("researcher", "fact-checker", "source-verifier"))
    # The run's gates reach depth 3 (the agent's own `search`, the builtin
    # defaults such as `start_async_task`), the spec adds its own, and `execute`
    # stays locked although the spec tried to clear it.
    for node in (checker, verifier):
        assert node["search"] is True and node["start_async_task"] is True and node["execute"] is True
    assert checker["lookup"] is True
    assert "lookup" not in verifier
    assert "ask_user" not in checker


def test_a_delegating_node_is_told_how_to_use_its_own_subagents(build, tree_module, agents_service):
    prompts = importlib.import_module("harness.prompt_engineering.prompts.capabilities_prompt")

    def prompt(path):
        return build(_tree(tree_module), path)["system_prompt"]

    assert prompt(("researcher",)).startswith("You are the researcher.")
    assert prompts.DELEGATING_SUBAGENT_PROMPT in prompt(("researcher",))
    assert prompts.DELEGATING_SUBAGENT_PROMPT in prompt(("researcher", "fact-checker"))
    assert prompts.DELEGATING_SUBAGENT_PROMPT not in prompt(("researcher", "fact-checker", "source-verifier"))
    assert prompts.DELEGATING_SUBAGENT_PROMPT not in prompt(("writer",))


def test_no_blocking_task_tool_is_built(deep_agent_module, agents_service, monkeypatch):
    """Through the real create_deep_agent: deepagents would add its blocking
    general-purpose sub-agent and the `task` tool; the build switches it off."""
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")

    class Bare(deep_agent_module.DeepAgent):
        name = "no-task-build"

        def register_agent(self):
            return None

    agent = Bare(config={
        "context": {"user_id": "u", "conversation_id": "c", "run_id": "r", "use_memory": False},
        "run_config": {"configurable": {"thread_id": "branch"}},
    })
    monkeypatch.setattr(agent, "_build_composite_backend", lambda: StateBackend())
    monkeypatch.setattr(agent, "_builtin_tools", lambda: [])
    graph = agent.build_deep_agent(
        model=MODEL, middleware=[], interrupt_on={},
        subagents=[{"name": "researcher", "description": "d", "system_prompt": "p"}],
    )
    tools = set(graph.nodes["tools"].bound.tools_by_name)
    assert "task" not in tools
    assert {"start_async_task", "check_async_task", "update_async_task", "cancel_async_task", "list_async_tasks"} <= tools


def test_a_tree_too_deep_fails_the_build(build, tree_module):
    sub = tree_module.subagent
    deep = sub("a", "d", "p", subagents=[sub("b", "d", "p", subagents=[sub("c", "d", "p", subagents=[sub("d", "d", "p")])])])
    with pytest.raises(ValueError, match="4 levels below the agent"):
        build([deep])


def test_a_compiled_sub_agent_fails_the_build(build):
    with pytest.raises(ValueError, match="cannot run as a background task"):
        build([{"name": "x", "description": "d", "runnable": object()}])


# ---------------------------------------------------------------------------
# The YAML agent
# ---------------------------------------------------------------------------
def test_every_omni_subagent_can_delegate_two_levels_down(build, tree_module, agents_service):
    """Omni opts in: its general-purpose, researcher and writer sub-agents each
    hand work to a `helper`, which hands work to a `sub-helper` — the third
    level, which does the work itself."""
    omni_module = importlib.import_module("deep_agents.omni_agent")
    agent = omni_module.OmniAgent.__new__(omni_module.OmniAgent)
    agent.skills_paths = []
    specs = agent.register_subagents()
    tree_module.validate_subagent_tree(specs)

    # Declared once by Omni, so the build adds no second general-purpose.
    assert _children(build(specs)) == ["general-purpose", "researcher", "writer"]
    for top in ("general-purpose", "researcher", "writer"):
        assert _children(build(specs, (top,))) == ["helper"]
        assert _children(build(specs, (top, "helper"))) == ["sub-helper"]
        assert _children(build(specs, (top, "helper", "sub-helper"))) is None


def test_the_yaml_agent_declares_the_tree(agents_service, spec_module):
    yaml_module = importlib.import_module("harness.abstractions.yaml_agent")
    agent = yaml_module.YamlDeepAgent.__new__(yaml_module.YamlDeepAgent)
    agent._spec = _agent_spec(
        spec_module,
        tools=[NATIVE_PRESENT],
        subagents=[_sa("researcher", {**_sa("fact-checker", _sa("source-verifier")), "model": "openai:gpt-4o"})],
    )
    agent._source_dir = None
    agent._owner_user_id = None
    agent._definition_files = {}
    agent.context = {}
    agent.name = "nested-demo"
    agent.tools = []

    [researcher] = agent.register_subagents()
    [checker] = researcher["subagents"]
    [verifier] = checker["subagents"]
    assert (researcher["name"], checker["name"], verifier["name"]) == ("researcher", "fact-checker", "source-verifier")
    assert checker["model"] == "openai:gpt-4o" and verifier["model"] == MODEL
    assert verifier["system_prompt"] == "You are the source-verifier."
    assert "tools" not in checker  # inherits
    assert "subagents" not in verifier
