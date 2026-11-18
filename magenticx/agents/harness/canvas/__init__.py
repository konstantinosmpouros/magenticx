"""The canvas agent loop (plan 44, Phase 4.3): what a turn tells the agent about its documents.

Two pieces of text, both added to the turn's user message by the stream route
(``utils/canvas_turn.py``) and never shown in the chat:

* ``edit`` — **Ask agent on a selection**: the run context's ``canvas_edit``
  (the passage, its headings, the instruction, a preset), validated
  fail-closed and rendered as a scoped instruction that asks for a targeted
  ``edit_file`` on that passage only;
* ``notes`` — **the user's edits since the agent's last turn**: one short note
  per document with a compact diff, from the seen markers
  (:mod:`harness.conversation_files.seen`).

``turn`` puts them into the message. Everything the user wrote (selection,
headings, instruction, the document text in a diff) goes in only as fenced
data, with the fence escaped inside it, so it can never pose as the platform.
"""
from harness.canvas.edit import CanvasEdit, CanvasEditRefused, parse_canvas_edit, render_canvas_edit
from harness.canvas.notes import render_edit_notes
from harness.canvas.turn import apply_canvas_turn

__all__ = [
    "CanvasEdit",
    "CanvasEditRefused",
    "apply_canvas_turn",
    "parse_canvas_edit",
    "render_canvas_edit",
    "render_edit_notes",
]
