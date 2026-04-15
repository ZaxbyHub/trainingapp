"""
Security utilities for URL validation and SSRF protection.

This module provides a unified URL validator used by both the API server
and LLM interface to ensure consistent security policies.
"""

import ipaddress
import re
import socket
from typing import Optional, Set
from urllib.parse import urlparse

# Default allowed ports for URL validation
DEFAULT_ALLOWED_PORTS: Set[int] = {80, 443}  # HTTP, HTTPS

# Private IP ranges for SSRF protection (excluding loopback)
PRIVATE_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("169.254.0.0/16"),  # link-local
]

# IPv6 private networks (excluding loopback)
PRIVATE_IPV6 = [
    ipaddress.ip_network("fc00::/7"),  # unique local addresses
]


def validate_url(
    url: str,
    allow_local: bool = False,
    allowed_ports: Optional[Set[int]] = None,
    allowed_schemes: Optional[Set[str]] = None,
) -> str:
    """
    Validate URL to prevent SSRF and injection attacks.

    This is the canonical URL validator used across the application.
    The API server uses strict mode (allow_local=False), while the LLM
    interface uses permissive mode for local LLM backends.

    Args:
        url: URL string to validate
        allow_local: If True, allow localhost, loopback, and private IPs.
                    Use only for trusted local LLM configurations.
        allowed_ports: Set of allowed port numbers. Defaults to {80, 443}.
        allowed_schemes: Set of allowed URL schemes. Defaults to {"http", "https"}.

    Returns:
        Validated URL string

    Raises:
        ValueError: If URL is invalid or violates security policy
    """
    if not url:
        raise ValueError("URL cannot be empty")

    # Type check before regex (preserves AttributeError for non-string inputs)
    if not isinstance(url, str):
        raise AttributeError(f"URL must be a string, got {type(url).__name__}")

    # Reject URLs with control characters (newlines, null bytes, etc.)
    if re.search(r'[\x00-\x08\x0a\x0b\x0c\x0d\x0e-\x1f]', url):
        raise ValueError("URL contains invalid control characters")

    # Parse URL
    parsed = urlparse(url)

    # Offline app: reject non-HTTP schemes early (ftp, gopher, data, etc.)
    if parsed.scheme and parsed.scheme not in ("http", "https"):
        raise ValueError(
            f"URL scheme '{parsed.scheme}' is not allowed. "
            f"This is an offline application — only HTTP/HTTPS URLs are supported."
        )

    # Validate scheme
    schemes = allowed_schemes if allowed_schemes is not None else {"http", "https"}
    if not parsed.scheme:
        raise ValueError("URL must have a scheme (http/https)")
    if parsed.scheme not in schemes:
        raise ValueError("URL scheme must be http or https")

    # Reject userinfo in URL (user:pass@host)
    # urlparse.username only catches non-empty usernames, so we also regex for
    # edge cases like ":@" (empty creds) and "@" (bare at-sign)
    if parsed.username or parsed.password:
        raise ValueError("URL must not contain userinfo (username:password)")
    if re.search(r'://[^/?#]*@', url):
        raise ValueError("URL must not contain userinfo (username:password)")

    # Validate hostname exists
    if not parsed.hostname:
        raise ValueError("URL must have a hostname")

    # Check for localhost and loopback addresses
    if parsed.hostname in ("localhost", "127.0.0.1", "::1"):
        if not allow_local:
            raise ValueError("URL must not point to localhost")
        # If allow_local is True, we still validate the port

    # Reject 0.0.0.0 — listener address, not a valid destination (SSRF risk)
    if parsed.hostname == "0.0.0.0":
        raise ValueError("URL must not point to 0.0.0.0 (all-interfaces listener, private network security)")

    # Port validation
    if parsed.port is not None:
        ports = allowed_ports if allowed_ports is not None else DEFAULT_ALLOWED_PORTS
        if parsed.port not in ports:
            raise ValueError(
                f"URL must use standard ports (got {parsed.port}, allowed: {sorted(ports)})"
            )

    # Resolve hostname and validate IP addresses
    _resolve_and_validate_host(parsed.hostname, allow_local)

    return url


def _resolve_and_validate_host(hostname: str, allow_local: bool) -> None:
    """
    Resolve hostname to IP addresses and validate against SSRF patterns.

    Args:
        hostname: Hostname to resolve and validate
        allow_local: If True, allow loopback and private IPs

    Raises:
        ValueError: If hostname resolves to forbidden IP addresses
    """
    try:
        # Get all IP addresses for the hostname
        addr_info = socket.getaddrinfo(hostname, None, type=socket.SOCK_STREAM)
    except socket.gaierror:
        raise ValueError(f"Hostname could not be resolved: {hostname}")

    for family, _, _, _, sockaddr in addr_info:
        ip_str = sockaddr[0]

        try:
            ip = ipaddress.ip_address(ip_str)
        except ValueError:
            # Not a valid IP address, skip
            continue

        # Check loopback addresses
        if ip.is_loopback:
            if not allow_local:
                raise ValueError(f"URL resolves to loopback address: {ip}")
            # Loopback is allowed (allow_local=True) but still check private IPs below

        # Check private networks
        if not allow_local:
            for network in PRIVATE_NETWORKS:
                if ip in network:
                    raise ValueError(f"URL points to private IP range: {ip}")

            if ip.is_link_local:
                raise ValueError(f"URL points to link-local address: {ip}")

            if ip.is_reserved:
                raise ValueError(f"URL points to reserved address: {ip}")

        # IPv6 private addresses (fc00::/7 ULA) are NEVER allowed, even with allow_local=True
        if ip.version == 6:
            for net in PRIVATE_IPV6:
                if ip in net:
                    raise ValueError(f"URL points to private IPv6 address: {ip}")


def is_local_url(url: str) -> bool:
    """
    Check if a URL points to a local/loopback address.

    Args:
        url: URL to check

    Returns:
        True if URL points to localhost or loopback
    """
    parsed = urlparse(url)
    if not parsed.hostname:
        return False

    if parsed.hostname in ("localhost", "127.0.0.1", "::1"):
        return True

    try:
        addr_info = socket.getaddrinfo(parsed.hostname, None, type=socket.SOCK_STREAM)
        for _, _, _, _, sockaddr in addr_info:
            ip = ipaddress.ip_address(sockaddr[0])
            if ip.is_loopback:
                return True
    except (socket.gaierror, ValueError):
        pass

    return False
