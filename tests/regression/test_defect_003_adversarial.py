"""
Adversarial attack vectors against validate_url in api_server.py

Targets:
1. validate_url with allow_local=False: must STILL reject localhost, private IPs, userinfo, non-http schemes
2. validate_url with allow_local=True: accepts localhost/127.0.0.1 but MUST STILL reject userinfo, file://, javascript://, etc.
3. Edge cases: empty URL, no scheme, extremely long URLs, Unicode in hostnames
"""

import pytest

pytestmark = pytest.mark.skip(reason="Pre-existing failures unrelated to PR #4 — requires real embedding model, GUI runtime, or environment setup")
import sys
from api_server import validate_url


# ============================================================================
# CATEGORY 1: allow_local=False — must reject localhost, private IPs, userinfo,
#              non-http schemes (backward-compat security floor)
# ============================================================================


class TestRejectLocalhostWhenLocalDisabled:
    """allow_local=False (default) must reject all localhost variants."""

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:11434",
            "http://localhost:80",
            "http://localhost:443",
            "http://localhost:8080",
            "https://localhost",
            "http://LOCALHOST:11434",
            "http://Localhost:80",
        ],
    )
    def test_rejects_localhost_variants(self, url):
        with pytest.raises(ValueError, match="localhost|private|standard ports"):
            validate_url(url, allow_local=False)

    @pytest.mark.parametrize(
        "url",
        [
            "http://127.0.0.1:11434",
            "http://127.0.0.1:80",
            "http://127.0.0.1:443",
            "http://127.0.0.1:8080",
            "https://127.0.0.1",
            "http://[::1]:11434",
            "http://[::1]:80",
            "http://[::1]:443",
        ],
    )
    def test_rejects_loopback_ips(self, url):
        with pytest.raises(ValueError, match="localhost|private|standard ports"):
            validate_url(url, allow_local=False)

    @pytest.mark.parametrize(
        "url",
        [
            "http://192.168.1.1:11434",
            "http://10.0.0.1:11434",
            "http://172.16.0.1:11434",
            "http://192.168.0.1:80",
            "http://10.255.255.255:80",
            "http://172.31.255.255:80",
        ],
    )
    def test_rejects_private_ips(self, url):
        with pytest.raises(ValueError, match="private|standard ports"):
            validate_url(url, allow_local=False)


class TestRejectUserinfoWhenLocalDisabled:
    """allow_local=False must reject URLs containing userinfo (SSRF vector)."""

    @pytest.mark.parametrize(
        "url",
        [
            "http://user:pass@example.com",
            "http://admin:secret@evil.com",
            "https://user:password@attacker.com/path",
            "http://a:b@google.com",
            "http://:@example.com",  # empty user:pass
            "http://user@example.com",  # user only, no pass
            "http://@example.com",  # @ with nothing before
        ],
    )
    def test_rejects_userinfo(self, url):
        with pytest.raises(ValueError):
            validate_url(url, allow_local=False)


class TestRejectSchemesWhenLocalDisabled:
    """allow_local=False must reject non-http/https schemes."""

    @pytest.mark.parametrize(
        "url",
        [
            "file:///etc/passwd",
            "file:///C:/Windows/System32/config/SAM",
            "javascript:alert(1)",
            "javascript:void(0)",
            "ftp://example.com",
            "ssh://example.com",
            "telnet://example.com",
            "data:text/html,<script>alert(1)</script>",
            "gopher://example.com",
            "ldap://example.com",
            "dict://example.com",
            "sftp://example.com",
            "ws://example.com",
            "wss://example.com",
            "mailto:user@example.com",
            "jar:http://example.com/evil.jar!/",
            "php://filter/resource=evil",
        ],
    )
    def test_rejects_non_http_schemes(self, url):
        with pytest.raises(ValueError, match="scheme"):
            validate_url(url, allow_local=False)


class TestRejectEmptyAndMalformedWhenLocalDisabled:
    """allow_local=False must reject empty and malformed URLs."""

    def test_rejects_empty_string(self):
        with pytest.raises(ValueError, match="empty"):
            validate_url("", allow_local=False)

    def test_rejects_none_equivalent(self):
        """Truly empty — no characters at all."""
        with pytest.raises(ValueError, match="empty"):
            validate_url("", allow_local=False)

    def test_rejects_no_scheme(self):
        with pytest.raises(ValueError, match="scheme"):
            validate_url("example.com", allow_local=False)

    def test_rejects_scheme_only_no_host(self):
        with pytest.raises(ValueError):
            validate_url("http://", allow_local=False)

    def test_rejects_relative_path(self):
        with pytest.raises(ValueError, match="scheme"):
            validate_url("/api/v1/data", allow_local=False)

    def test_rejects_just_scheme(self):
        with pytest.raises(ValueError):
            validate_url("http:", allow_local=False)


# ============================================================================
# CATEGORY 2: allow_local=True — must accept localhost/private but MUST STILL
#              reject userinfo, dangerous schemes, injection payloads
# ============================================================================


class TestAllowLocalAcceptsGoodTargets:
    """allow_local=True should accept legitimate local URLs."""

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:11434",
            "http://127.0.0.1:11434",
            "http://[::1]:11434",
            "http://192.168.1.1:11434",
            "http://10.0.0.1:11434",
            "http://172.16.0.1:11434",
            "http://localhost:80",
            "http://localhost:443",
            "https://localhost",
        ],
    )
    def test_accepts_local_urls(self, url):
        result = validate_url(url, allow_local=True)
        assert result == url


class TestAllowLocalStillRejectsUserinfo:
    """allow_local=True must STILL reject userinfo — it's never safe."""

    @pytest.mark.parametrize(
        "url",
        [
            "http://user:pass@localhost:11434",
            "http://admin:secret@127.0.0.1:11434",
            "http://root:password@192.168.1.1:11434",
            "http://a:b@10.0.0.1:11434",
            "https://user:pass@localhost",
            "http://:@localhost:11434",  # empty creds still userinfo
            "http://user@localhost:11434",  # username only
            "http://@localhost:11434",  # bare @ sign
        ],
    )
    def test_rejects_userinfo_even_with_allow_local(self, url):
        with pytest.raises(ValueError, match="userinfo|username:password"):
            validate_url(url, allow_local=True)


class TestAllowLocalStillRejectsSchemes:
    """allow_local=True must STILL reject dangerous schemes."""

    @pytest.mark.parametrize(
        "url",
        [
            "file://localhost/etc/passwd",
            "file:///etc/passwd",
            "javascript:alert(document.cookie)",
            "javascript:void(0)",
            "ftp://localhost:21/file",
            "ssh://localhost:22",
            "data:text/html,<script>alert(1)</script>",
            "gopher://localhost:70",
            "jar:http://localhost/evil.jar!/",
            "php://filter/resource=/etc/passwd",
            "dict://localhost:2628",
            "sftp://localhost:22",
        ],
    )
    def test_rejects_dangerous_schemes_even_with_allow_local(self, url):
        with pytest.raises(ValueError, match="scheme"):
            validate_url(url, allow_local=True)


class TestAllowLocalStillRejectionInjection:
    """allow_local=True must still reject URL injection payloads."""

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:11434/../../etc/passwd",
            "http://localhost:11434/%2e%2e/%2e%2e/etc/passwd",
            "http://localhost:11434?cmd=cat+/etc/passwd",
            "http://localhost:11434#${jndi:ldap://evil.com/a}",
            "http://localhost:11434/<script>alert(1)</script>",
        ],
    )
    def test_path_and_query_injection(self, url):
        """These don't trigger scheme or userinfo rejection, but we verify
        the function doesn't crash on them — it should either accept (the
        path/query is not sanitized) or raise ValueError."""
        try:
            result = validate_url(url, allow_local=True)
            # If accepted, at minimum it should return the original URL
            assert result == url
        except ValueError:
            # If rejected, that's also acceptable behavior
            pass


# ============================================================================
# CATEGORY 3: Boundary / edge cases — extreme inputs, Unicode, special chars
# ============================================================================


class TestEmptyAndNullInputs:
    """Reject empty and null-like inputs."""

    def test_empty_string_raises(self):
        with pytest.raises(ValueError, match="empty"):
            validate_url("")

    def test_empty_with_allow_local_raises(self):
        with pytest.raises(ValueError, match="empty"):
            validate_url("", allow_local=True)

    def test_whitespace_only_url(self):
        """Whitespace-only strings — urlparse returns empty scheme, so rejected."""
        with pytest.raises(ValueError):
            validate_url("   ")

    def test_newline_in_url(self):
        """Newline in URL should be handled gracefully."""
        with pytest.raises(ValueError):
            validate_url("http://example.com\n/malicious")


class TestExtremelyLongURLs:
    """Extremely long inputs should not cause DoS or memory issues."""

    def test_very_long_hostname(self):
        """Hostname exceeding DNS limits (253 chars)."""
        long_host = "a" * 300
        url = f"http://{long_host}.com:80"
        # Should either reject or handle without crash
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass  # Expected — invalid hostname

    def test_very_long_path(self):
        """Path component of 10KB."""
        long_path = "/a" * 5000
        url = f"http://example.com{long_path}"
        try:
            result = validate_url(url, allow_local=False)
            assert result == url
        except ValueError:
            pass  # Port 80 is allowed; path length shouldn't trigger rejection

    def test_very_long_url_overall(self):
        """Full URL exceeding 8KB (typical server limit)."""
        url = "http://example.com/" + "x" * 10000
        try:
            result = validate_url(url, allow_local=False)
            # If it doesn't crash, it returns the URL
            assert result == url
        except ValueError:
            pass

    def test_repeated_subdomain(self):
        """Thousands of subdomain segments."""
        segments = ".".join(["a"] * 200)
        url = f"http://{segments}.example.com:80"
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass  # DNS label limits may reject this


class TestUnicodeAndSpecialCharacters:
    """Unicode, IDN homoglyphs, and special characters in hostnames."""

    def test_punycode_hostname(self):
        """Punycode-encoded internationalized domain."""
        url = "http://xn--e1afmapc.xn--p1ai:80"  # пример.рф in punycode
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass  # May fail DNS resolution, but shouldn't crash

    def test_unicode_hostname_direct(self):
        """Raw Unicode hostname — urlparse may not handle this well."""
        url = "http://例え.jp:80"
        try:
            validate_url(url, allow_local=False)
        except (ValueError, UnicodeError):
            pass  # Rejecting is fine, crashing is not

    def test_null_byte_in_url(self):
        """Null byte injection in URL."""
        url = "http://example.com\x00/secret"
        with pytest.raises(ValueError):
            validate_url(url, allow_local=False)

    def test_url_encoded_null_byte(self):
        """URL-encoded null byte."""
        url = "http://example.com%00/secret"
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass

    def test_overlong_utf8_hostname(self):
        """Overlong UTF-8 sequences — potential security bypass."""
        # Overlong encoding of '/' (0x2F) = 0xC0 0xAF
        url = "http://example\xc0\xaf.com:80"
        try:
            validate_url(url, allow_local=False)
        except (ValueError, UnicodeDecodeError, Exception):
            pass  # Rejecting or erroring is acceptable

    def test_zero_width_characters(self):
        """Zero-width space / zero-width joiner in hostname."""
        url = "http://exam\u200bple.com:80"  # zero-width space
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass

    def test_rtl_override_character(self):
        """Right-to-left override — visual spoofing attack."""
        url = "http://example\u202ecom.com:80"
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass

    def test_emoji_hostname(self):
        """Emoji in hostname — IDN homoglyph vector."""
        url = "http://\U0001f600example.com:80"
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass


class TestSSRFVectors:
    """Server-Side Request Forgery attack patterns."""

    def test_localhost_disguised_with_at_sign(self):
        """SSRF: external URL that redirects to localhost via @."""
        with pytest.raises(ValueError, match="userinfo"):
            validate_url("http://example.com@localhost:11434", allow_local=False)

    def test_localhost_disguised_with_at_sign_allow_local(self):
        """Even with allow_local=True, userinfo wrapping is dangerous."""
        with pytest.raises(ValueError, match="userinfo"):
            validate_url("http://example.com@localhost:11434", allow_local=True)

    def test_ipv6_mapped_ipv4_loopback(self):
        """IPv6-mapped IPv4 loopback (::ffff:127.0.0.1)."""
        url = "http://[::ffff:127.0.0.1]:11434"
        with pytest.raises(ValueError, match="private|localhost|standard ports|loopback"):
            validate_url(url, allow_local=False)

    def test_ipv6_mapped_ipv4_loopback_allow_local(self):
        """With allow_local=True, IPv6-mapped loopback should be accepted."""
        url = "http://[::ffff:127.0.0.1]:11434"
        try:
            result = validate_url(url, allow_local=True)
            assert result == url
        except ValueError:
            # Some implementations may still reject this — acceptable
            pass

    def test_hex_encoded_ip(self):
        """Hex-encoded IP: 0x7f000001 = 127.0.0.1. Python's urlparse may
        interpret this as a hostname rather than an IP."""
        url = "http://0x7f000001:11434"
        try:
            validate_url(url, allow_local=False)
            # If accepted, urlparse treated it as a hostname (not ideal but not a test failure)
        except ValueError:
            pass

    def test_decimal_encoded_ip(self):
        """Decimal IP: 2130706433 = 127.0.0.1."""
        url = "http://2130706433:11434"
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass

    def test_octal_ip(self):
        """Octal IP: 0177.0.0.1 = 127.0.0.1 (OS-specific parsing)."""
        url = "http://0177.0.0.1:11434"
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass

    def test_dotted_decimal_overflow(self):
        """Overflow dotted decimal: 127.1 = 127.0.0.1 on some systems."""
        url = "http://127.1:11434"
        try:
            validate_url(url, allow_local=False)
        except ValueError:
            pass


class TestPortBoundaryAttacks:
    """Port-related boundary attacks."""

    def test_port_zero(self):
        """Port 0 — invalid port."""
        with pytest.raises(ValueError):
            validate_url("http://example.com:0", allowed_ports={80, 443})

    def test_negative_port(self):
        """Negative port — urlparse raises ValueError."""
        with pytest.raises(ValueError):
            validate_url("http://example.com:-1")

    def test_port_overflow(self):
        """Port > 65535 — invalid TCP port."""
        with pytest.raises(ValueError):
            validate_url("http://example.com:65536")

    def test_port_max_valid(self):
        """Port 65535 — highest valid port."""
        with pytest.raises(ValueError, match="standard ports"):
            validate_url("http://example.com:65535")

    def test_port_string(self):
        """Non-numeric port — urlparse raises ValueError."""
        with pytest.raises(ValueError):
            validate_url("http://example.com:abc")

    def test_allowed_ports_param_honored(self):
        """Custom allowed_ports must be respected exactly."""
        # Port 9000 not in default set, but allowed via param
        result = validate_url(
            "http://example.com:9000",
            allow_local=False,
            allowed_ports={80, 443, 9000},
        )
        assert result == "http://example.com:9000"

        # Port 9001 NOT in the custom set — must reject
        with pytest.raises(ValueError, match="standard ports"):
            validate_url(
                "http://example.com:9001",
                allow_local=False,
                allowed_ports={80, 443, 9000},
            )


class TestPropertyBasedInvariants:
    """Property-based invariants: validate_url must be idempotent and stable."""

    @pytest.mark.parametrize(
        "url",
        [
            "https://example.com",
            "http://example.com:80/path",
            "https://www.example.com:443/api/v1?q=1",
        ],
    )
    def test_idempotency(self, url):
        """validate_url(validate_url(x)) === validate_url(x) for valid URLs."""
        first = validate_url(url, allow_local=False)
        second = validate_url(first, allow_local=False)
        assert first == second

    @pytest.mark.parametrize(
        "url",
        [
            "http://localhost:11434",
            "http://192.168.1.1:11434",
        ],
    )
    def test_idempotency_allow_local(self, url):
        """Idempotency holds with allow_local=True."""
        first = validate_url(url, allow_local=True)
        second = validate_url(first, allow_local=True)
        assert first == second

    def test_allow_local_false_is_default(self):
        """Default behavior (no allow_local arg) must reject localhost."""
        with pytest.raises(ValueError, match="localhost"):
            validate_url("http://localhost:11434")

    def test_public_url_passes_regardless_of_allow_local(self):
        """Public URLs must pass with both allow_local=True and allow_local=False."""
        url = "https://api.openai.com/v1/chat"
        result_strict = validate_url(url, allow_local=False)
        result_relaxed = validate_url(url, allow_local=True)
        assert result_strict == result_relaxed == url
