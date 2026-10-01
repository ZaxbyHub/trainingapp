"""Player-origin routes of api_server's web-archive mount (trace
browser-training-parity AC3, Phase 4.2 predicate P4).

When api_server serves the built web archive it can also be reached as the
course PLAYER origin: the boot frame files must carry
Cross-Origin-Resource-Policy: cross-origin (the COEP require-corp app page
embeds them cross-origin), the course worker stays at /training/sw.js, and
every other /training/* path is a plain 404 - never the app shell. Mirrors
web_ui/vite.config.ts trainingRouteMiddleware (pinned by
web_ui/src/lib/packs/__tests__/player-origin-hosting.test.ts).

The TestClient is used WITHOUT its context manager (the lifespan would build
the real engine); the middleware reads the `_web_archive_dir` module global at
request time, so it is pointed at a temporary archive directory.
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
    monkeypatch.setattr(api_server, "_web_archive_dir", tmp_path)
    return TestClient(api_server.app)


@pytest.mark.parametrize(
    "path",
    ["/training", "/training/", "/training/pack-a/story.html", "/training/pack-a/assets/x.js", "/training/index.html"],
)
def test_training_paths_are_404_not_the_app_shell(archive_client, path):
    response = archive_client.get(path)
    assert response.status_code == 404
    assert "app shell" not in response.text
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["cross-origin-embedder-policy"] == "require-corp"


@pytest.mark.parametrize("path", ["/training-boot.html", "/training-boot.js"])
def test_boot_files_are_embeddable_cross_origin(archive_client, path):
    response = archive_client.get(path)
    assert response.headers["cross-origin-resource-policy"] == "cross-origin"
    assert response.headers["cross-origin-embedder-policy"] == "require-corp"
    assert response.headers["x-content-type-options"] == "nosniff"


def test_course_worker_path_is_not_short_circuited(archive_client):
    response = archive_client.get("/training/sw.js")
    # Without a mounted archive the router answers; the point is that the
    # middleware let the worker path through and stamped nosniff on it.
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers.get("cross-origin-resource-policy") != "cross-origin"


def test_api_only_deployments_are_untouched(monkeypatch):
    monkeypatch.setattr(api_server, "_web_archive_dir", None)
    response = TestClient(api_server.app).get("/training/pack-a/story.html")
    assert "cross-origin-embedder-policy" not in response.headers
