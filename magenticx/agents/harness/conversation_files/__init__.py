"""A conversation's files, stored in ``agent_runtime`` (plan 36).

Everything a conversation owns used to be a directory on the agents volume; it
is now rows, and lives exactly as long as the conversation:

* ``store`` — the tables: content-addressed, encrypted blobs per user, and
  the conversation's paths that name them. Forks copy paths, never bytes.
* ``inputs`` — ``/conversation/input/``, a read-only view of the uploads the
  bridge holds in ``chat_db``. Nothing is copied.
* ``files`` — one run's view of both; ``backend`` — that view as the
  deepagents filesystem behind ``/conversation/``, ``/large_tool_results/``
  and ``/conversation_history/``.
* ``versions`` — a canvas document's append-only versions (plan 44), over
  the same blobs; ``seen`` — what the agent last saw of each; ``comments`` —
  the user's comment threads on a document (Phase 4.4).
* ``paths`` — the one normaliser every path goes through; ``cipher`` — the
  checkpointer's AES key and cipher, reused for the bytes.
"""
from harness.conversation_files.backend import ConversationFilesBackend
from harness.conversation_files.comments import DocumentCommentStore
from harness.conversation_files.files import ConversationFiles
from harness.conversation_files.inputs import InputsUnavailable
from harness.conversation_files.store import ConversationFileStore
from harness.conversation_files.versions import DocumentVersionStore

__all__ = [
    "ConversationFileStore",
    "ConversationFiles",
    "ConversationFilesBackend",
    "DocumentCommentStore",
    "DocumentVersionStore",
    "InputsUnavailable",
]
