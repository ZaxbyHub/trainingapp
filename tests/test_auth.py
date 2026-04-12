"""
Tests for Authentication Module (Phase 1.5 - Auth Implementation)

Tests the JWT token authentication and API key authentication for the Document Q&A API.
Covers auth disabled/enabled modes, token generation, verification, and endpoint protection.
"""

import pytest
import os
import sys
from datetime import timedelta, datetime
from unittest.mock import patch, MagicMock
import importlib

# Check if JWT library is available
try:
    from jose import JWTError, jwt
    JWT_AVAILABLE = True
except ImportError:
    JWT_AVAILABLE = False


def reload_auth_module(enable_auth=None, api_key=None, jwt_secret=None):
    """Helper to reload auth module with specific environment."""
    # Set environment before reload
    if enable_auth is not None:
        os.environ["ENABLE_AUTH"] = "true" if enable_auth else "false"
    if api_key is not None:
        os.environ["API_KEY"] = api_key
    if jwt_secret is not None:
        os.environ["JWT_SECRET"] = jwt_secret
    
    # Remove cached modules
    if 'auth' in sys.modules:
        del sys.modules['auth']
    if 'api_server' in sys.modules:
        del sys.modules['api_server']
    
    # Reimport
    import auth
    import api_server
    return auth, api_server


class TestAuthModuleDirect:
    """Tests for auth.py module functions when JWT is available."""
    
    pytestmark = pytest.mark.skipif(not JWT_AVAILABLE, reason="JWT library not installed")

    def test_create_access_token_returns_string(self):
        """Test that create_access_token returns a JWT string."""
        auth, _ = reload_auth_module(enable_auth=False)
        token = auth.create_access_token({"sub": "test_user"})
        assert isinstance(token, str)
        assert len(token) > 0

    def test_create_access_token_with_custom_expiration(self):
        """Test token creation with custom expiration."""
        auth, _ = reload_auth_module(enable_auth=False)
        expires = timedelta(hours=1)
        token = auth.create_access_token({"sub": "test_user"}, expires_delta=expires)
        assert isinstance(token, str)

    def test_verify_token_valid(self):
        """Test verifying a valid token."""
        auth, _ = reload_auth_module(enable_auth=False)
        token = auth.create_access_token({"sub": "test_user"})
        payload = auth.verify_token(token)
        assert payload is not None
        assert payload.get("sub") == "test_user"

    def test_verify_token_invalid(self):
        """Test verifying an invalid token returns None."""
        auth, _ = reload_auth_module(enable_auth=False)
        result = auth.verify_token("invalid.token.string")
        assert result is None

    def test_verify_token_empty(self):
        """Test verifying an empty token returns None."""
        auth, _ = reload_auth_module(enable_auth=False)
        result = auth.verify_token("")
        assert result is None

    def test_expired_token_verification(self):
        """Test that expired tokens are rejected by verify_token."""
        auth, _ = reload_auth_module(enable_auth=False)
        # Create token with negative expiration (already expired)
        expired_token = auth.create_access_token(
            {"sub": "test"},
            expires_delta=timedelta(seconds=-1)
        )
        result = auth.verify_token(expired_token)
        assert result is None  # Should return None for expired token


class TestAuthModuleSync:
    """Tests for auth module synchronous behavior."""

    def test_get_auth_status_disabled(self):
        """Test get_auth_status when auth is disabled."""
        auth, _ = reload_auth_module(enable_auth=False)
        status = auth.get_auth_status()
        assert status["enabled"] is False
        assert status["jwt_available"] == JWT_AVAILABLE

    def test_get_auth_status_enabled(self):
        """Test get_auth_status when auth is enabled."""
        auth, _ = reload_auth_module(enable_auth=True)
        status = auth.get_auth_status()
        assert status["enabled"] is True

    def test_require_auth_returns_callable(self):
        """Test that require_auth returns the authenticate function."""
        auth, _ = reload_auth_module(enable_auth=False)
        result = auth.require_auth()
        assert callable(result)

    def test_api_key_configuration(self):
        """Test that API_KEY is loaded from environment or generated."""
        auth, _ = reload_auth_module(api_key="my-custom-key")
        assert auth.API_KEY == "my-custom-key"

    def test_jwt_secret_configuration(self):
        """Test that JWT_SECRET is loaded from environment."""
        auth, _ = reload_auth_module(jwt_secret="my-custom-secret")
        assert auth.JWT_SECRET == "my-custom-secret"


class TestAuthAsync:
    """Tests for the async authenticate function."""
    
    pytestmark = pytest.mark.asyncio

    async def test_authenticate_disabled_returns_success(self):
        """Test that authenticate returns success when auth is disabled."""
        auth, _ = reload_auth_module(enable_auth=False)
        
        result = await auth.authenticate(bearer=None, api_key=None)
        assert result["authenticated"] is True
        assert result["method"] == "disabled"

    async def test_authenticate_enabled_no_credentials_raises(self):
        """Test that authenticate raises 401 when auth enabled but no credentials."""
        auth, _ = reload_auth_module(enable_auth=True)
        from fastapi import HTTPException
        
        with pytest.raises(HTTPException) as exc_info:
            await auth.authenticate(bearer=None, api_key=None)
        assert exc_info.value.status_code == 401

    async def test_authenticate_enabled_valid_api_key(self):
        """Test authentication with valid API key."""
        auth, _ = reload_auth_module(enable_auth=True, api_key="valid-key-123")
        
        result = await auth.authenticate(bearer=None, api_key="valid-key-123")
        assert result["authenticated"] is True
        assert result["method"] == "api_key"

    async def test_authenticate_enabled_invalid_api_key_raises(self):
        """Test that invalid API key raises 401."""
        auth, _ = reload_auth_module(enable_auth=True, api_key="correct-key")
        from fastapi import HTTPException
        
        with pytest.raises(HTTPException) as exc_info:
            await auth.authenticate(bearer=None, api_key="wrong-key")
        assert exc_info.value.status_code == 401


# =============================================================================
# FastAPI Integration Tests
# =============================================================================

from fastapi.testclient import TestClient


class TestAuthDisabledIntegration:
    """Integration tests when authentication is disabled."""

    def test_root_endpoint_works_without_auth(self):
        """Test / endpoint works without authentication."""
        _, api_server = reload_auth_module(enable_auth=False)
        client = TestClient(api_server.app)
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["service"] == "Document Q&A API"
        assert "version" in data

    def test_auth_status_shows_disabled(self):
        """Test /auth/status shows auth is disabled."""
        _, api_server = reload_auth_module(enable_auth=False)
        client = TestClient(api_server.app)
        response = client.get("/auth/status")
        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is False
        assert data["methods"] == []

    def test_protected_endpoint_works_without_auth_when_disabled(self):
        """Test protected endpoints work without auth when auth is disabled."""
        _, api_server = reload_auth_module(enable_auth=False)
        client = TestClient(api_server.app)
        
        with patch("api_server.engine") as mock_engine:
            mock_engine.get_stats.return_value = {
                "document_count": 5,
                "chunk_count": 20,
                "embedding_model": "test",
                "llm": {"backend": "test"},
                "documents": []
            }
            
            response = client.get("/stats")
            assert response.status_code == 200


class TestAuthEnabledIntegration:
    """Integration tests when authentication is enabled."""

    def test_root_endpoint_works_without_auth(self):
        """Test / endpoint is public and works without auth."""
        _, api_server = reload_auth_module(enable_auth=True)
        client = TestClient(api_server.app)
        response = client.get("/")
        assert response.status_code == 200
        data = response.json()
        assert data["service"] == "Document Q&A API"
        assert "version" in data

    def test_auth_status_is_public(self):
        """Test /auth/status is public and shows auth is enabled."""
        _, api_server = reload_auth_module(enable_auth=True)
        client = TestClient(api_server.app)
        response = client.get("/auth/status")
        assert response.status_code == 200
        data = response.json()
        assert data["enabled"] is True
        assert "bearer" in data["methods"]
        assert "api_key" in data["methods"]

    @pytest.mark.skipif(not JWT_AVAILABLE, reason="JWT library not installed")
    def test_auth_token_with_valid_api_key(self):
        """Test /auth/token returns JWT when given valid API key."""
        _, api_server = reload_auth_module(enable_auth=True, api_key="test-api-key-integration")
        client = TestClient(api_server.app)
        
        response = client.post("/auth/token", json={"api_key": "test-api-key-integration"})
        assert response.status_code == 200
        data = response.json()
        assert "access_token" in data
        assert data["token_type"] == "bearer"
        assert isinstance(data["access_token"], str)

    def test_auth_token_with_invalid_api_key(self):
        """Test /auth/token rejects invalid API key."""
        _, api_server = reload_auth_module(enable_auth=True, api_key="test-api-key-integration")
        client = TestClient(api_server.app)
        response = client.post("/auth/token", json={"api_key": "wrong-key"})
        assert response.status_code == 401

    def test_protected_endpoint_without_auth_returns_401(self):
        """Test protected endpoints return 401 without authentication."""
        _, api_server = reload_auth_module(enable_auth=True)
        client = TestClient(api_server.app)
        
        with patch("api_server.engine") as mock_engine:
            mock_engine.get_stats.return_value = {
                "document_count": 5,
                "chunk_count": 20,
                "embedding_model": "test",
                "llm": {"backend": "test"},
                "documents": []
            }
            
            response = client.get("/stats")
            assert response.status_code == 401

    def test_protected_endpoint_with_api_key_header(self):
        """Test protected endpoints accept API key via X-API-Key header."""
        _, api_server = reload_auth_module(enable_auth=True, api_key="test-api-key-integration")
        client = TestClient(api_server.app)
        
        with patch("api_server.engine") as mock_engine:
            mock_engine.get_stats.return_value = {
                "document_count": 5,
                "chunk_count": 20,
                "embedding_model": "test",
                "llm": {"backend": "test"},
                "documents": []
            }
            
            response = client.get("/stats", headers={"X-API-Key": "test-api-key-integration"})
            assert response.status_code == 200

    def test_protected_endpoint_with_invalid_api_key_returns_401(self):
        """Test protected endpoints reject invalid API key."""
        _, api_server = reload_auth_module(enable_auth=True, api_key="test-api-key-integration")
        client = TestClient(api_server.app)
        
        with patch("api_server.engine") as mock_engine:
            mock_engine.get_stats.return_value = {
                "document_count": 5,
                "chunk_count": 20,
                "embedding_model": "test",
                "llm": {"backend": "test"},
                "documents": []
            }
            
            response = client.get("/stats", headers={"X-API-Key": "wrong-api-key"})
            assert response.status_code == 401

    def test_auth_token_endpoint_disabled_when_auth_disabled(self):
        """Test /auth/token returns 503 when auth is disabled."""
        _, api_server = reload_auth_module(enable_auth=False)
        client = TestClient(api_server.app)
        response = client.post("/auth/token", json={"api_key": "any-key"})
        assert response.status_code == 503
        assert "not enabled" in response.json()["detail"].lower()


@pytest.mark.skipif(not JWT_AVAILABLE, reason="JWT library not installed")
class TestJWTAuthIntegration:
    """Integration tests for JWT authentication."""

    def test_protected_endpoint_with_valid_jwt(self):
        """Test protected endpoints accept valid JWT token."""
        _, api_server = reload_auth_module(
            enable_auth=True, 
            api_key="test-api-key-jwt",
            jwt_secret="test-jwt-secret-jwt"
        )
        client = TestClient(api_server.app)
        
        # First get a token
        token_response = client.post("/auth/token", json={"api_key": "test-api-key-jwt"})
        assert token_response.status_code == 200
        token = token_response.json()["access_token"]
        
        # Use token to access protected endpoint
        with patch("api_server.engine") as mock_engine:
            mock_engine.get_stats.return_value = {
                "document_count": 5,
                "chunk_count": 20,
                "embedding_model": "test",
                "llm": {"backend": "test"},
                "documents": []
            }
            
            response = client.get("/stats", headers={"Authorization": f"Bearer {token}"})
            assert response.status_code == 200

    def test_protected_endpoint_with_invalid_jwt_returns_401(self):
        """Test protected endpoints reject invalid JWT token."""
        _, api_server = reload_auth_module(enable_auth=True, jwt_secret="test-jwt-secret")
        client = TestClient(api_server.app)
        
        with patch("api_server.engine") as mock_engine:
            mock_engine.get_stats.return_value = {
                "document_count": 5,
                "chunk_count": 20,
                "embedding_model": "test",
                "llm": {"backend": "test"},
                "documents": []
            }
            
            response = client.get("/stats", headers={"Authorization": "Bearer invalid.token.here"})
            assert response.status_code == 401

    def test_expired_token_rejected(self):
        """Test that expired tokens are rejected."""
        _, api_server = reload_auth_module(enable_auth=True, jwt_secret="test-jwt-secret")
        client = TestClient(api_server.app)
        
        # Create an expired token using the same secret
        expired_token = jwt.encode(
            {"sub": "test", "exp": datetime.utcnow() - timedelta(hours=1)},
            "test-jwt-secret",
            algorithm="HS256"
        )
        
        with patch("api_server.engine") as mock_engine:
            mock_engine.get_stats.return_value = {
                "document_count": 0,
                "chunk_count": 0,
                "embedding_model": "test",
                "llm": {"backend": "test"},
                "documents": []
            }
            
            response = client.get("/stats", headers={"Authorization": f"Bearer {expired_token}"})
            assert response.status_code == 401


class TestSecurityHeaders:
    """Tests for proper security headers in responses."""

    def test_401_response_includes_authentication_info(self):
        """Test that 401 responses indicate authentication is required."""
        _, api_server = reload_auth_module(enable_auth=True, api_key="secure-key")
        client = TestClient(api_server.app)
        
        with patch("api_server.engine") as mock_engine:
            mock_engine.get_stats.return_value = {
                "document_count": 0,
                "chunk_count": 0,
                "embedding_model": "test",
                "llm": {"backend": "test"},
                "documents": []
            }
            
            response = client.get("/stats")
            assert response.status_code == 401
            # FastAPI should return proper error detail
            assert "detail" in response.json()


class TestAuthEdgeCases:
    """Edge case tests for authentication."""

    def test_auth_status_always_accessible_when_disabled(self):
        """Test that /auth/status is always accessible when auth is disabled."""
        _, api_server = reload_auth_module(enable_auth=False)
        client = TestClient(api_server.app)
        response = client.get("/auth/status")
        assert response.status_code == 200

    def test_auth_status_always_accessible_when_enabled(self):
        """Test that /auth/status is always accessible when auth is enabled."""
        _, api_server = reload_auth_module(enable_auth=True)
        client = TestClient(api_server.app)
        response = client.get("/auth/status")
        assert response.status_code == 200

    def test_root_always_accessible_when_disabled(self):
        """Test that / endpoint is always accessible when auth is disabled."""
        _, api_server = reload_auth_module(enable_auth=False)
        client = TestClient(api_server.app)
        response = client.get("/")
        assert response.status_code == 200

    def test_root_always_accessible_when_enabled(self):
        """Test that / endpoint is always accessible when auth is enabled."""
        _, api_server = reload_auth_module(enable_auth=True)
        client = TestClient(api_server.app)
        response = client.get("/")
        assert response.status_code == 200

    def test_protected_endpoints_all_require_auth_when_enabled(self):
        """Test that all protected endpoints require auth when auth is enabled."""
        _, api_server = reload_auth_module(
            enable_auth=True,
            api_key="test-key",
            jwt_secret="test-secret"
        )
        client = TestClient(api_server.app)
        
        # List of protected endpoints to test with GET requests
        protected_get_endpoints = ["/stats", "/documents"]
        
        for url in protected_get_endpoints:
            with patch("api_server.engine") as mock_engine:
                mock_engine.get_stats.return_value = {
                    "document_count": 0,
                    "chunk_count": 0,
                    "embedding_model": "test",
                    "llm": {"backend": "test"},
                    "documents": []
                }
                mock_engine.list_documents.return_value = []
                
                response = client.get(url)
                assert response.status_code == 401, f"Endpoint {url} should return 401 without auth"


class TestTimingSafeComparison:
    """Security tests for timing-safe comparison in API key authentication."""

    def test_api_key_uses_constant_time_comparison(self):
        """
        Verify that API key comparison uses constant-time comparison.
        
        This test checks the source code of the authenticate function to ensure
        it uses secrets.compare_digest or hmac.compare_digest instead of direct
        string comparison (==), which is vulnerable to timing attacks.
        """
        import inspect
        import auth
        
        # Get the source code of the authenticate function
        auth_source = inspect.getsource(auth.authenticate)
        
        # Check for constant-time comparison functions
        has_secrets_compare = "secrets.compare_digest" in auth_source
        has_hmac_compare = "hmac.compare_digest" in auth_source
        
        # Check for vulnerable direct comparison
        # Look for patterns like "api_key ==" or "api_key ==" (comparison with api_key variable)
        has_direct_comparison = (
            "api_key ==" in auth_source or 
            "api_key  ==" in auth_source or
            "== API_KEY" in auth_source or
            " == API_KEY" in auth_source
        )
        
        # The test passes if constant-time comparison is used
        assert has_secrets_compare or has_hmac_compare, (
            "API key authentication must use secrets.compare_digest() or "
            "hmac.compare_digest() for timing-safe comparison. Found direct "
            "string comparison which is vulnerable to timing attacks."
        )
        
        # Fail if direct comparison is detected
        if has_direct_comparison:
            raise AssertionError(
                "Found direct string comparison (api_key == API_KEY) in "
                "authenticate function. This is vulnerable to timing attacks. "
                "Use secrets.compare_digest() or hmac.compare_digest() instead."
            )


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
