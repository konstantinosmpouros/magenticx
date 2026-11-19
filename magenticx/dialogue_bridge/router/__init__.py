from router.account.auth import router as auth_router
from router.agents.catalog import router as catalog_router
from router.agents.user_agents import router as user_agents_router
from router.agents.tools import router as agent_tools_router
from router.inference.runs import router as inference_router
from router.account.preferences import router as preferences_router
from router.conversations.conversations import router as conversations_router
from router.documents.documents import router as documents_router
from router.documents.comments import router as document_comments_router
from router.documents.suggestions import router as document_suggestions_router
from router.account.account import router as account_router
from router.agents.commands import router as commands_router
from router.account.export import router as export_router
from router.conversations.favicons import router as favicons_router
from router.conversations.messages import router as messages_router
from router.conversations.attachments import router as attachments_router
from router.conversations.sharing import router as shared_conv_router
from router.inference.speech import router as speech_router
from router.conversations.search import router as search_router
from router.inference.voice import router as voice_router
from router.agents.skills import router as skills_router
from router.agents.memories import router as memories_router
from router.automation.scheduled_tasks import router as scheduled_tasks_router
from router.inference.tasks import conversation_router as conversation_tasks_router
from router.inference.tasks import router as tasks_router
from router.account.usage import router as usage_router
from router.automation.workflows import router as workflows_router
from router.automation.workflows import runs_router as workflow_runs_router
from router.internal.conversations import router as internal_conversations_router
from router.internal.memory import router as internal_memory_router

__all__ = [
    "agent_tools_router",
    "attachments_router",
    "auth_router",
    "catalog_router",
    "conversation_tasks_router",
    "conversations_router",
    "documents_router",
    "document_comments_router",
    "document_suggestions_router",
    "account_router",
    "commands_router",
    "export_router",
    "favicons_router",
    "inference_router",
    "internal_conversations_router",
    "internal_memory_router",
    "memories_router",
    "messages_router",
    "preferences_router",
    "scheduled_tasks_router",
    "search_router",
    "shared_conv_router",
    "skills_router",
    "tasks_router",
    "speech_router",
    "usage_router",
    "user_agents_router",
    "voice_router",
    "workflow_runs_router",
    "workflows_router",
]
