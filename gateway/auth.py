"""Google Sign-In authentication for the voice agent.

Verifies Google Identity Services JWTs and manages session tokens.
"""

from __future__ import annotations

import logging
import os

from google.auth.transport import requests as google_requests
from google.oauth2 import id_token

from gateway.db import (
    create_auth_session,
    get_user,
    upsert_user,
    validate_auth_session,
)

log = logging.getLogger("gateway.auth")

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "")
ALLOWED_EMAILS: set[str] = set()

_allowed_raw = os.getenv("ALLOWED_EMAILS", "")
if _allowed_raw.strip():
    ALLOWED_EMAILS = {e.strip().lower() for e in _allowed_raw.split(",") if e.strip()}


def verify_google_jwt(jwt_token: str) -> dict:
    """Verify a Google Sign-In JWT and return the decoded payload.

    Raises ValueError if the token is invalid, expired, or from an
    unverified email.
    """
    if not GOOGLE_CLIENT_ID:
        raise ValueError("GOOGLE_CLIENT_ID not configured on server")

    idinfo = id_token.verify_oauth2_token(
        jwt_token,
        google_requests.Request(),
        GOOGLE_CLIENT_ID,
    )

    # Verify issuer
    if idinfo.get("iss") not in ("accounts.google.com", "https://accounts.google.com"):
        raise ValueError("Invalid JWT issuer")

    # Require verified email
    if not idinfo.get("email_verified"):
        raise ValueError("Email not verified by Google")

    # Optional allowlist
    if ALLOWED_EMAILS:
        email = idinfo.get("email", "").lower()
        if email not in ALLOWED_EMAILS:
            raise ValueError(f"Email {email} not in allowed list")

    return idinfo


def authenticate_google(jwt_token: str) -> tuple[int, str, dict]:
    """Full Google auth flow: verify JWT → upsert user → create session.

    Returns (user_id, session_token, user_info_dict).
    Raises ValueError on auth failure.
    """
    idinfo = verify_google_jwt(jwt_token)

    user_id = upsert_user(
        google_id=idinfo["sub"],
        email=idinfo.get("email", ""),
        name=idinfo.get("name", ""),
        avatar_url=idinfo.get("picture", ""),
    )

    session_token = create_auth_session(user_id)

    user_info = {
        "id": user_id,
        "email": idinfo.get("email", ""),
        "name": idinfo.get("name", ""),
        "avatar_url": idinfo.get("picture", ""),
    }

    log.info("Google auth OK: %s (%s)", user_info["email"], user_id)
    return user_id, session_token, user_info


def authenticate_session_token(token: str) -> tuple[int, dict] | None:
    """Validate a stored session token.

    Returns (user_id, user_info_dict) or None if invalid/expired.
    """
    user_id = validate_auth_session(token)
    if user_id is None:
        return None

    user = get_user(user_id)
    if user is None:
        return None

    user_info = {
        "id": user["id"],
        "email": user["email"],
        "name": user["name"],
        "avatar_url": user["avatar_url"],
    }
    return user_id, user_info
