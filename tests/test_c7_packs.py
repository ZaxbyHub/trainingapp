"""C7 (issue #74) knowledge-pack route tests (Python backend).

Pins the /packs route family (list / install / rollback / remove) against the
real PackManager with the same stub-store technique tests/test_pack_manager.py
uses, the zip-extraction guard matrix shared with the Node helper
(desktop/main/backend/packs/zip-install.ts), and the documented unwired 503
degradation the conformance suite's check_packs_list accepts.
"""

import io
import shutil
import sys
import unittest.mock as mock
import zipfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import api_server  # noqa: E402
import vector_store as vector_store_module  # noqa: E402
from pack_manager import PackManager  # noqa: E402

pytestmark = pytest.mark.unit

VectorStore = vector_store_module.VectorStore

REPO = Path(__file__).resolve().parents[1]
FIXTURES = REPO / "contracts" / "fixtures" / "packs"


class StubEmbeddingModel:
    def __init__(self, model_name=None):
        self.model_name = model_name or "stub"

    def encode(self, texts):
        return [[0.1] * 384 for _ in texts]

    def encode_single(self, text):
        return [0.1] * 384


def make_store(tmp_path: Path) -> VectorStore:
    with mock.patch("vector_store.EmbeddingModel", StubEmbeddingModel):
        return VectorStore(db_path=str(tmp_path / "db"), embedding_model="stub")


def make_manager(tmp_path: Path) -> PackManager:
    return PackManager(make_store(tmp_path), packs_root=tmp_path / "packs")


def copy_fixture(name: str, dest: Path) -> Path:
    target = dest / name
    shutil.copytree(FIXTURES / name, target)
    return target


def zip_pack_dir(pack_dir: Path) -> bytes:
    """Zip a staged pack folder exactly like a dropped .zip would look."""
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for path in sorted(pack_dir.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(pack_dir).as_posix())
    return buffer.getvalue()


@pytest.fixture()
def client(tmp_path, monkeypatch):
    """TestClient with the api_server pack manager pointed at a real
    PackManager over a stub store. The patch lands AFTER TestClient startup
    because entering the context runs the lifespan, which constructs (and
    would otherwise overwrite) the module global."""
    manager = make_manager(tmp_path)
    with TestClient(api_server.app) as test_client:
        monkeypatch.setattr(api_server, "pack_manager", manager)
        yield test_client


def test_packs_unwired_answers_documented_503(monkeypatch):
    with TestClient(api_server.app) as test_client:
        monkeypatch.setattr(api_server, "pack_manager", None)
        response = test_client.get("/packs")
    assert response.status_code == 503
    assert "detail" in response.json()


def test_packs_list_shape_and_status(client, tmp_path):
    source = copy_fixture("bundled-min", tmp_path)
    client.post(
        "/packs/install",
        files={"file": ("bundled-min.zip", zip_pack_dir(source), "application/zip")},
    )

    response = client.get("/packs")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["packs"], list)
    row = next(p for p in body["packs"] if p["pack_id"] == "bundled-min")
    assert row["version"] == "1.0.0"
    assert row["name"] == "Bundled Minimum Fixture"
    assert row["source_class"] == "bundled"
    assert row["active"] is True
    assert row["supersedes"] == []
    assert row["published_at"] == "2026-09-16T00:00:00Z"


def test_packs_install_zip_and_list_afterwards(client, tmp_path):
    source = copy_fixture("bundled-min", tmp_path)
    response = client.post(
        "/packs/install",
        files={"file": ("bundled-min.zip", zip_pack_dir(source), "application/zip")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["pack_id"] == "bundled-min"
    assert body["version"] == "1.0.0"
    assert body["docs_installed"] == 2
    assert body["chunks_added"] == 2
    assert body["superseded"] == []
    assert body["warnings"] == []

    listed = client.get("/packs").json()["packs"]
    assert any(p["pack_id"] == "bundled-min" and p["active"] for p in listed)


def test_packs_install_refuses_non_zip_and_guard_violations(client, tmp_path):
    # Not a zip filename.
    response = client.post(
        "/packs/install",
        files={"file": ("pack.txt", b"not a zip", "application/octet-stream")},
    )
    assert response.status_code == 409

    # Zip without a root manifest.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("docs/readme.txt", "no manifest here")
    response = client.post(
        "/packs/install",
        files={"file": ("manifestless.zip", buffer.getvalue(), "application/zip")},
    )
    assert response.status_code == 409
    assert "pack.json" in response.json()["detail"]

    # Zip with a traversal entry path.
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("../escape.txt", "nope")
    response = client.post(
        "/packs/install",
        files={"file": ("evil.zip", buffer.getvalue(), "application/zip")},
    )
    assert response.status_code == 409
    assert "unsafe archive entry" in response.json()["detail"]


def test_packs_rollback_reactivates_target_version(client, tmp_path):
    for name in ("versioned-a-1.0.0", "versioned-a-2.0.0"):
        source = copy_fixture(name, tmp_path)
        installed = client.post(
            "/packs/install",
            files={"file": (f"{name}.zip", zip_pack_dir(source), "application/zip")},
        )
        assert installed.status_code == 200, installed.text

    response = client.post(
        "/packs/rollback", json={"pack_id": "versioned-a", "to_version": "1.0.0"}
    )
    assert response.status_code == 200
    assert response.json() == {"ok": True}

    listed = client.get("/packs").json()["packs"]
    statuses = {
        (p["version"], p["active"]) for p in listed if p["pack_id"] == "versioned-a"
    }
    assert ("1.0.0", True) in statuses
    assert ("2.0.0", False) in statuses


def test_packs_remove_version_then_all(client, tmp_path):
    for name in ("versioned-a-1.0.0", "versioned-a-2.0.0"):
        source = copy_fixture(name, tmp_path)
        client.post(
            "/packs/install",
            files={"file": (f"{name}.zip", zip_pack_dir(source), "application/zip")},
        )

    response = client.post(
        "/packs/remove", json={"pack_id": "versioned-a", "version": "2.0.0"}
    )
    assert response.status_code == 200
    assert response.json() == {"removed": 1}

    response = client.post("/packs/remove", json={"pack_id": "versioned-a"})
    assert response.status_code == 200
    assert response.json() == {"removed": 1}

    listed = client.get("/packs").json()["packs"]
    assert not any(p["pack_id"] == "versioned-a" for p in listed)


def test_packs_validation_errors_return_422(client):
    response = client.post("/packs/rollback", json={"pack_id": ""})
    assert response.status_code == 422
    response = client.post("/packs/remove", json={"to_version": 3})
    assert response.status_code == 422
