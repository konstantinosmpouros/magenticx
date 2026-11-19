"""Accept or reject the user's pending suggestions on a canvas document (plan 44, Phase 4.6).

One tool, ``review_suggestions``, in ``tool.py``; this barrel fixes the public
surface so ``harness.tools.canvas_suggestions`` stays the import path.
"""
from harness.tools.canvas_suggestions.tool import REVIEW_TOOL_NAME, build_review_suggestions_tool

__all__ = ["REVIEW_TOOL_NAME", "build_review_suggestions_tool"]
