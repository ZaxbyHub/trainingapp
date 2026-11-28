"""Release contract guardrail: testers releases must carry the full offline bundle.

The executable gate is scripts/check-portable-bundle.mjs; this test proves the
gate rejects an incomplete tree and accepts a complete one, and that the
documented recipe still points at both of them. (User rule 2026-11-27: a
notes-only or ZIP-only release is not a usable testers release.)
"""
from __future__ import annotations

import json
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CHECKER = REPO_ROOT / "scripts" / "check-portable-bundle.mjs"
BUILDER = REPO_ROOT / "scripts" / "build-portable-release.mjs"
CONTRACT = REPO_ROOT / "docs" / "releases" / "offline-bundle-contract.md"


def _synthetic_bundle(tmp_path: Path) -> Path:
    root = tmp_path / "win-unpacked"
    (root / "resources").mkdir(parents=True)
    (root / "TrainingApp.exe").write_bytes(b"exe")
    (root / "resources" / "app.asar").write_bytes(b"asar")
    (root / "resources" / "web_ui").mkdir()
    (root / "resources" / "web_ui" / "index.html").write_text("<html></html>")
    manifest = {
        "version": 1,
        "airgap": False,
        "models": [
            {
                "id": f"m{i}",
                "group": group,
                "files": [
                    {
                        "path": f"models/{group}/m{i}/model.gguf",
                        "required": True,
                        "sizeBytes": 16,
                    }
                ],
            }
            for i, group in enumerate(
                ["embedding", "reranker", "llm-quality", "llm-fast"]
            )
        ],
        "packs": [
            {
                "id": "docs",
                "dir": "bundled-docs/opmed-initial-1.0.0",
                "files": [
                    {
                        "path": "packs/bundled-docs/opmed-initial-1.0.0/pack.json",
                        "sizeBytes": 16,
                    }
                ],
            },
            {
                "id": "course",
                "dir": "training/opmed-cdp-mlc-1.0.1",
                "files": [
                    {
                        "path": "packs/training/opmed-cdp-mlc-1.0.1/pack.json",
                        "sizeBytes": 16,
                    }
                ],
            },
        ],
    }
    (root / "resources" / "manifest.json").write_text(json.dumps(manifest))
    for entry in [f["files"][0]["path"] for f in manifest["models"]] + [
        f["files"][0]["path"] for f in manifest["packs"]
    ]:
        target = root / "resources" / entry
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"x" * 16)
    return root


def _check(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["node", str(CHECKER), str(root)], capture_output=True, text=True
    )


def test_release_contract_files_exist():
    assert CONTRACT.is_file(), "offline release contract is missing"
    assert BUILDER.is_file(), "canonical portable build recipe is missing"
    assert CHECKER.is_file(), "bundle completeness gate is missing"
    text = CONTRACT.read_text(encoding="utf-8")
    for marker in [
        "build-portable-release.mjs",
        "check-portable-bundle.mjs",
        "SHA256SUMS-parts.txt",
        "README-portable.txt",
    ]:
        assert marker in text, f"contract omits required asset/tool: {marker}"


def test_checker_accepts_complete_bundle(tmp_path: Path):
    result = _check(_synthetic_bundle(tmp_path))
    assert result.returncode == 0, result.stderr
    assert "OK" in result.stdout


def test_checker_rejects_missing_payload(tmp_path: Path):
    root = _synthetic_bundle(tmp_path)
    (root / "resources" / "models" / "llm-quality" / "m2" / "model.gguf").unlink()
    result = _check(root)
    assert result.returncode == 1, result.stdout
    assert "models/llm-quality/m2/model.gguf" in result.stderr
