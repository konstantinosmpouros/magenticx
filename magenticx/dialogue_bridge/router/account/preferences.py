from fastapi import APIRouter, Depends, status
from core.logging import get_logger, set_context
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser, require_csrf_protection
from core.database import get_db
from schema import UserPreferences
from engine.account.preferences import load_preferences, save_preferences
from utils.validators import validate_userId


router = APIRouter()
logger = get_logger(__name__)


@router.get("/{user_id}", response_model=UserPreferences, status_code=status.HTTP_200_OK)
async def get_user_preferences(
    user_id: str,
    _: AuthUser = Depends(validate_userId),
    db: AsyncSession = Depends(get_db),
):
    """
    Return generic user preferences (future-proof JSON) scoped to the given user.
    """
    set_context(user_id=user_id)
    preferences = await load_preferences(db, user_id)
    if preferences is None:
        logger.info("preferences_defaulted", "No stored user preferences found")
        return UserPreferences()

    logger.info("preferences_loaded", "Loaded user preferences")
    return preferences


@router.put("/{user_id}", response_model=UserPreferences, status_code=status.HTTP_200_OK)
async def upsert_user_preferences(
    user_id: str,
    payload: UserPreferences,
    _: AuthUser = Depends(validate_userId),
    __: None = Depends(require_csrf_protection),
    db: AsyncSession = Depends(get_db),
):
    """
    Replace the user's preferences document with the provided payload.
    """
    set_context(user_id=user_id)
    saved = await save_preferences(db, user_id, payload)
    await db.commit()
    # Custom-instruction content is user PII — log only the enabled flag and
    # the personality preset id, never the text itself.
    logger.info(
        "preferences_updated",
        "Updated user preferences",
        suggestions_enabled=saved.suggestionsEnabled,
        improve_model=saved.improveModel,
        personality=saved.personality,
        custom_instructions_enabled=saved.customInstructions.enabled,
        voice_mode_voice=saved.voiceModeVoice,
        voice_mode_language=saved.voiceModeLanguage,
    )
    return saved
