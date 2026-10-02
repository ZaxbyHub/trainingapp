"""api_server is NOT a course-player host (trace browser-training-parity,
ADR-0012, final-critic FC1).

The browser app's course player runs on a dedicated player origin, and every
same-origin endpoint of the server answering that origin is reachable by
untrusted course JS through uncontrolled same-origin documents (the boot page).
api_server carries the unauthenticated document/ask/settings/packs API, so when
it serves the built web archive it must never answer as a player origin: the
boot files, the course worker and every /training/* path are a plain 404 (never
the app shell), while the app shell keeps COOP/COEP and is never frameable
(frame-ancestors 'none' + X-Frame-Options: DENY).

The TestClient is used WITHOUT its context manager (the lifespan would build
the real engine); the middleware reads the `_web_archive_dir` module global at
request time, so it is pointed at a temporary archive directory that contains
the player files, proving the 404 comes from the middleware, not a missing file.
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import api_server  # noqa: E402


@pytest.fixture()
def archive_client(tmp_path, monkeypatch):
    (tmp_path / "index.html").write_text("<html>app shell</html>", encoding="utf-8")
    (tmp_path / "training-boot.html").write_text("<html>boot</html>", encoding="utf-8")
    (tmp_path / "training-boot.js").write_text("// boot", encoding="utf-8")
    (tmp_path / "training").mkdir()
    (tmp_path / "training" / "sw.js").write_text("// worker", encoding="utf-8")
    monkeypatch.setattr(api_server, "_web_archive_dir", tmp_path)
    return TestClient(api_server.app)


@pytest.mark.parametrize(
    "path",
    [
        "/training-boot.html",
        "/training-boot.js",
        "/training/sw.js",
        "/training",
        "/training/",
        "/training/pack-a/story.html",
        "/training/pack-a/assets/x.js",
        "/training/index.html",
    ],
)
def test_player_paths_are_404_never_served(archive_client, path):
    response = archive_client.get(path)
    assert response.status_code == 404
    assert "app shell" not in response.text
    assert "boot" not in response.text
    assert "worker" not in response.text
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cross-origin-embedder-policy"] == "require-corp"
    assert response.headers.get("cross-origin-resource-policy") != "cross-origin"
    # Every response of the archive mount is unframeable, the 404s included.
    assert response.headers["content-security-policy"] == "frame-ancestors 'none'"
    assert response.headers["x-frame-options"] == "DENY"


@pytest.mark.parametrize(
    "path", ["/training-boot.html", "/training-boot.js", "/training/sw.js"]
)
def test_player_paths_answer_head_with_a_non_html_404(archive_client, path):
    # The browser app probes HEAD /training-boot.html before using the
    # loopback-alias player origin; a non-HTML 404 makes it report course
    # playback as unavailable on this host (framed-refusal.test.tsx HU1).
    response = archive_client.head(path)
    assert response.status_code == 404
    assert "text/html" not in response.headers.get("content-type", "")


@pytest.mark.parametrize("path", ["/", "/index.html", "/some/spa/route", "/health"])
def test_app_shell_responses_are_never_frameable(archive_client, path):
    response = archive_client.get(path)
    assert response.headers["content-security-policy"] == "frame-ancestors 'none'"
    assert response.headers["x-frame-options"] == "DENY"
    assert response.headers["cross-origin-opener-policy"] == "same-origin"
    assert response.headers["cross-origin-embedder-policy"] == "require-corp"


def test_api_only_deployments_are_untouched(monkeypatch):
    monkeypatch.setattr(api_server, "_web_archive_dir", None)
    response = TestClient(api_server.app).get("/training/pack-a/story.html")
    assert "cross-origin-embedder-policy" not in response.headers
    assert "x-frame-options" not in response.headers
