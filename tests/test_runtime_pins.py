"""Frozen-check C11 (issue #277 AC4): one Node pin in the tree (.nvmrc read
by every setup-node step via node-version-file; no lts/*, no literal
node-version), the same major in the three engines.node fields, and no
end-of-life Python in the test matrix.
"""
from __future__ import annotations

import json
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKFLOWS = REPO_ROOT / ".github" / "workflows"

# Electron 44 bundles Node 24; the pin must match it (issue #277 AC4).
EXPECTED_NODE_MAJOR = "24"
# EOL table (end-of-life dates): 3.9 Oct 2025, 3.10 Oct 2026. 3.11/3.12 are
# supported as of this PR (Nov 2026).
EOL_PYTHONS = {"3.9", "3.10", "3.8", "3.7"}


def _setup_node_steps():
    for path in sorted(WORKFLOWS.glob("*.yml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        for job_id, job in (data.get("jobs") or {}).items():
            for step in job.get("steps", []) or []:
                uses = str(step.get("uses", ""))
                if "actions/setup-node" in uses:
                    yield path.name, job_id, step


def test_node_pins():
    seen = 0
    for wf_name, job_id, step in _setup_node_steps():
        seen += 1
        with_opts = step.get("with") or {}
        assert (
            with_opts.get("node-version-file") == ".nvmrc"
        ), f"{wf_name}/{job_id}: setup-node does not read .nvmrc"
        assert (
            "node-version" not in with_opts
        ), f"{wf_name}/{job_id}: setup-node pins a literal node-version"
    assert seen >= 10, f"expected the 10 known setup-node sites, saw {seen}"
    # no floating LTS anywhere (executable YAML values, parsed — comments are
    # dropped by safe_load, so a comment mentioning lts/* cannot keep this red)
    for path in sorted(WORKFLOWS.glob("*.yml")):
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
        assert "lts/*" not in json.dumps(data), f"{path.name}: lts/* float remains"
    nvmrc = (REPO_ROOT / ".nvmrc").read_text(encoding="utf-8").strip()
    assert (
        nvmrc == EXPECTED_NODE_MAJOR
    ), f".nvmrc pins {nvmrc!r}, want {EXPECTED_NODE_MAJOR!r}"
    for pkg in ("web_ui", "desktop", "packtool"):
        data = json.loads(
            (REPO_ROOT / pkg / "package.json").read_text(encoding="utf-8")
        )
        engines = data.get("engines") or {}
        assert engines.get("node", "").startswith(
            f">={EXPECTED_NODE_MAJOR}.0.0"
        ), f"{pkg}: engines.node is {engines.get('node')!r}"
    # the three engines agree with each other
    majors = set()
    for pkg in ("web_ui", "desktop", "packtool"):
        data = json.loads(
            (REPO_ROOT / pkg / "package.json").read_text(encoding="utf-8")
        )
        majors.add((data.get("engines") or {}).get("node"))
    assert len(majors) == 1, f"engines.node diverge across packages: {majors}"


def test_python_matrix():
    data = yaml.safe_load((WORKFLOWS / "test.yml").read_text(encoding="utf-8"))
    versions: set[str] = set()
    for job in (data.get("jobs") or {}).values():
        matrix = (job.get("strategy") or {}).get("matrix") or {}
        for key, value in matrix.items():
            if "python" in key.lower() and isinstance(value, list):
                versions |= {str(v) for v in value}
    assert versions, "test.yml declares no python matrix"
    dead = versions & EOL_PYTHONS
    assert not dead, f"end-of-life Python(s) in the test matrix: {sorted(dead)}"
