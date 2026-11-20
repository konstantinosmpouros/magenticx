"""Inference runs: one assistant answer streamed from the agents service.

Split by concern: ``state`` (statuses, clock), ``runtime`` (a live run's
in-memory state), ``decisions`` (HITL), ``payloads`` (the UI's view of a run),
``finish`` (persist + run-finished hooks), ``manager`` (the run tasks),
``stream`` (replay to a client) and ``records`` (run rows in Postgres).
Import each name from its module; this package re-exports nothing.
"""
