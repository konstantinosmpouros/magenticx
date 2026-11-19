"""Slash commands (plan 35): the composer's ``/`` menu for one agent.

Thin: the catalog comes from the agents service through ``engine.agents.commands``,
which also refuses an agent this user may not run.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from core.auth.session import AuthUser
from core.database import get_db
from core.security.rate_limit import commands_rate_limit
from schema import CommandListResponse
from utils.validators import validate_userId
from engine.agents.commands import list_agent_commands

router = APIRouter()


@router.get("/{user_id}/{agent_id}", response_model=CommandListResponse, status_code=status.HTTP_200_OK)
async def get_agent_commands(
    user_id: str,
    agent_id: str,
    _: AuthUser = Depends(validate_userId),
    # After auth on purpose: the bucket is keyed on the path's {user_id}.
    __: None = Depends(commands_rate_limit),
    db: AsyncSession = Depends(get_db),
) -> CommandListResponse:
    """Every slash command for this agent, each runnable or with the reason it is not."""
    return await list_agent_commands(db, user_id, agent_id)
