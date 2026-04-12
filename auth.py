"""
Authentication module for the Document Q&A API.

Provides JWT token authentication for programmatic access and API key
authentication for GUI clients. Authentication can be disabled via
the ENABLE_AUTH environment variable for development.
"""

import os
import secrets
from datetime import datetime, timedelta
from typing import Optional

from fastapi import HTTPException, Security, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials, APIKeyHeader

# Try to import JWT libraries
try:
    from jose import JWTError, jwt
    JWT_AVAILABLE = True
except ImportError:
    JWT_AVAILABLE = False

# Configuration
ENABLE_AUTH = os.environ.get("ENABLE_AUTH", "false").lower() == "true"
JWT_SECRET = os.environ.get("JWT_SECRET", secrets.token_urlsafe(32))
JWT_ALGORITHM = "HS256"
JWT_EXPIRATION_HOURS = int(os.environ.get("JWT_EXPIRATION_HOURS", "24"))
API_KEY = os.environ.get("API_KEY", secrets.token_urlsafe(32))

# Security schemes
bearer_scheme = HTTPBearer(auto_error=False)
api_key_scheme = APIKeyHeader(name="X-API-Key", auto_error=False)


def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Create a JWT access token.

    Args:
        data: Data to encode in the token
        expires_delta: Optional custom expiration time

    Returns:
        JWT token string
    """
    if not JWT_AVAILABLE:
        raise RuntimeError("JWT library not available. Install python-jose[cryptography]")

    to_encode = data.copy()
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(hours=JWT_EXPIRATION_HOURS)
    to_encode.update({"exp": expire})
    encoded_jwt = jwt.encode(to_encode, JWT_SECRET, algorithm=JWT_ALGORITHM)
    return encoded_jwt


def verify_token(token: str) -> Optional[dict]:
    """
    Verify a JWT token.

    Args:
        token: JWT token string

    Returns:
        Decoded token payload or None if invalid
    """
    if not JWT_AVAILABLE:
        return None

    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
        return payload
    except JWTError:
        return None


async def authenticate(
    bearer: Optional[HTTPAuthorizationCredentials] = Security(bearer_scheme),
    api_key: Optional[str] = Security(api_key_scheme),
) -> dict:
    """
    Authenticate request using JWT Bearer token or API key.

    Args:
        bearer: Bearer token credentials
        api_key: API key from X-API-Key header

    Returns:
        Authentication context dict

    Raises:
        HTTPException: If authentication fails and ENABLE_AUTH is True
    """
    # If auth is disabled, allow all requests
    if not ENABLE_AUTH:
        return {"authenticated": True, "method": "disabled"}

    # Try JWT Bearer token first
    if bearer and bearer.credentials:
        payload = verify_token(bearer.credentials)
        if payload:
            return {"authenticated": True, "method": "jwt", "payload": payload}

    # Try API key (using constant-time comparison to prevent timing attacks)
    if api_key and secrets.compare_digest(api_key, API_KEY):
        return {"authenticated": True, "method": "api_key"}

    # Authentication failed
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid authentication credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )


def require_auth():
    """
    Dependency for endpoints that require authentication.

    Usage:
        @app.get("/protected")
        async def protected_endpoint(auth: dict = Depends(require_auth())):
            return {"message": "Authenticated"}
    """
    return authenticate


def get_auth_status() -> dict:
    """
    Get current authentication configuration status.

    Returns:
        Dict with auth configuration (safe for public exposure)
    """
    return {
        "enabled": ENABLE_AUTH,
        "jwt_available": JWT_AVAILABLE,
        "methods": ["bearer", "api_key"] if ENABLE_AUTH else [],
    }
