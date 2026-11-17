import pytest
from pydantic import ValidationError


# ----------------------------------------------------------------------
# Event type constants
# ----------------------------------------------------------------------
def test_event_type_constants(agents_service):
    ev = agents_service.agui_events
    assert ev.HITL_INTERRUPT_EVENT_TYPE == "HITL_INTERRUPT"
    assert ev.PLAN_SNAPSHOT_EVENT_TYPE == "PLAN_SNAPSHOT"
    assert ev.TASK_LAUNCHED_EVENT_TYPE == "TASK_LAUNCHED"
    assert ev.TASK_SETTLED_INLINE_EVENT_TYPE == "TASK_SETTLED_INLINE"


# ----------------------------------------------------------------------
# HITLInterruptEvent
# ----------------------------------------------------------------------
def test_hitl_interrupt_event_full(agents_service):
    ev = agents_service.agui_events
    model = ev.HITLInterruptEvent(
        thread_id="thread-1",
        interrupt={"value": "needs approval"},
        metadata={"source": "node-a"},
    )
    dumped = model.model_dump()
    assert dumped == {
        "thread_id": "thread-1",
        "interrupt": {"value": "needs approval"},
        "metadata": {"source": "node-a"},
    }


def test_hitl_interrupt_event_metadata_defaults_none(agents_service):
    ev = agents_service.agui_events
    model = ev.HITLInterruptEvent(thread_id="t", interrupt="raw-interrupt")
    dumped = model.model_dump()
    assert dumped["thread_id"] == "t"
    assert dumped["interrupt"] == "raw-interrupt"
    assert dumped["metadata"] is None


def test_hitl_interrupt_event_interrupt_accepts_any(agents_service):
    ev = agents_service.agui_events
    model = ev.HITLInterruptEvent(thread_id="t", interrupt=[1, 2, 3])
    assert model.interrupt == [1, 2, 3]


def test_hitl_interrupt_event_requires_thread_id(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.HITLInterruptEvent(interrupt="x")


def test_hitl_interrupt_event_requires_interrupt(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.HITLInterruptEvent(thread_id="t")


# ----------------------------------------------------------------------
# PlanItem + PlanSnapshot
# ----------------------------------------------------------------------
def test_plan_item_full(agents_service):
    ev = agents_service.agui_events
    item = ev.PlanItem(content="do thing", status="in_progress", metadata={"x": 1})
    dumped = item.model_dump()
    assert dumped == {
        "content": "do thing",
        "status": "in_progress",
        "metadata": {"x": 1},
    }


def test_plan_item_metadata_defaults_none(agents_service):
    ev = agents_service.agui_events
    item = ev.PlanItem(content="step", status="pending")
    assert item.model_dump()["metadata"] is None


@pytest.mark.parametrize("status", ["pending", "in_progress", "completed"])
def test_plan_item_valid_statuses(agents_service, status):
    ev = agents_service.agui_events
    item = ev.PlanItem(content="c", status=status)
    assert item.status == status


def test_plan_item_invalid_status_rejected(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.PlanItem(content="c", status="done")


def test_plan_item_requires_content(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.PlanItem(status="pending")


def test_plan_snapshot_full(agents_service):
    ev = agents_service.agui_events
    snapshot = ev.PlanSnapshot(
        items=[
            ev.PlanItem(content="a", status="pending"),
            ev.PlanItem(content="b", status="completed", metadata={"k": "v"}),
        ],
        updated_at=123456,
        metadata={"plan": "main"},
    )
    dumped = snapshot.model_dump()
    assert dumped["updated_at"] == 123456
    assert dumped["metadata"] == {"plan": "main"}
    assert len(dumped["items"]) == 2
    assert dumped["items"][0] == {"content": "a", "status": "pending", "metadata": None}
    assert dumped["items"][1] == {"content": "b", "status": "completed", "metadata": {"k": "v"}}


def test_plan_snapshot_optional_fields_default_none(agents_service):
    ev = agents_service.agui_events
    snapshot = ev.PlanSnapshot(items=[])
    dumped = snapshot.model_dump()
    assert dumped["items"] == []
    assert dumped["updated_at"] is None
    assert dumped["metadata"] is None


def test_plan_snapshot_coerces_dict_items(agents_service):
    ev = agents_service.agui_events
    snapshot = ev.PlanSnapshot(items=[{"content": "c", "status": "in_progress"}])
    assert isinstance(snapshot.items[0], ev.PlanItem)
    assert snapshot.items[0].content == "c"


def test_plan_snapshot_requires_items(agents_service):
    ev = agents_service.agui_events
    with pytest.raises(ValidationError):
        ev.PlanSnapshot()

