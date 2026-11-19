"""A user's preferences: the stored row, read back as the API's ``UserPreferences``.

The voice fields are normalized on the way in and out (an unknown voice or
language falls back to the default), so a stale stored value never reaches the
client. The caller owns the transaction: ``save_preferences`` stages the row and
the route commits.
"""
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from core.database import UserPreferencesTable
from engine.inference.voice import normalize_realtime_voice, normalize_voice_mode_language
from schema import UserPreferences


async def load_preferences(db: AsyncSession, user_id: str) -> UserPreferences | None:
    """The user's stored preferences, or None when they never saved any."""
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    row: UserPreferencesTable | None = result.scalar_one_or_none()
    if row is None:
        return None

    payload: dict = {
        "suggestions_enabled": bool(row.suggestions_enabled),
        "show_message_token_usage": bool(row.show_message_token_usage),
        "search_past_convs": bool(row.search_past_convs),
        "use_memory": bool(row.use_memory),
        "improve_model": bool(row.improve_model),
        # Schema-level validators normalize both: unknown personality ids
        # collapse to "default", stored custom-instruction text is re-sanitized.
        "personality": row.personality,
        "custom_instructions": row.custom_instructions if isinstance(row.custom_instructions, dict) else {},
        "voice_mode_voice": normalize_realtime_voice(row.voice_mode_voice),
        "voice_mode_language": normalize_voice_mode_language(row.voice_mode_language),
    }
    return UserPreferences.model_validate(payload)


async def save_preferences(db: AsyncSession, user_id: str, payload: UserPreferences) -> UserPreferences:
    """Stage the user's whole preferences document (insert or replace); return it as stored.

    Not committed — the route commits.
    """
    result = await db.execute(select(UserPreferencesTable).where(UserPreferencesTable.user_id == user_id))
    existing: UserPreferencesTable | None = result.scalar_one_or_none()
    voice_mode_voice = normalize_realtime_voice(payload.voiceModeVoice)
    voice_mode_language = normalize_voice_mode_language(payload.voiceModeLanguage)
    # Already normalized by the schema: personality is fail-closed against the
    # preset registry, custom-instruction text sanitized + length-capped.
    custom_instructions = payload.customInstructions.model_dump(mode="json")
    if existing:
        existing.suggestions_enabled = bool(payload.suggestionsEnabled)
        existing.show_message_token_usage = bool(payload.showMessageTokenUsage)
        existing.search_past_convs = bool(payload.searchPastConvs)
        existing.use_memory = bool(payload.useMemory)
        existing.improve_model = bool(payload.improveModel)
        existing.personality = payload.personality
        existing.custom_instructions = custom_instructions
        existing.voice_mode_voice = voice_mode_voice
        existing.voice_mode_language = voice_mode_language
    else:
        db.add(
            UserPreferencesTable(
                user_id=user_id,
                suggestions_enabled=bool(payload.suggestionsEnabled),
                show_message_token_usage=bool(payload.showMessageTokenUsage),
                search_past_convs=bool(payload.searchPastConvs),
                use_memory=bool(payload.useMemory),
                improve_model=bool(payload.improveModel),
                personality=payload.personality,
                custom_instructions=custom_instructions,
                voice_mode_voice=voice_mode_voice,
                voice_mode_language=voice_mode_language,
            )
        )

    return UserPreferences(
        suggestionsEnabled=bool(payload.suggestionsEnabled),
        showMessageTokenUsage=bool(payload.showMessageTokenUsage),
        searchPastConvs=bool(payload.searchPastConvs),
        useMemory=bool(payload.useMemory),
        improveModel=bool(payload.improveModel),
        personality=payload.personality,
        customInstructions=payload.customInstructions,
        voiceModeVoice=voice_mode_voice,
        voiceModeLanguage=voice_mode_language,
    )
