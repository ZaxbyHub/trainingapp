#!/usr/bin/env python3
"""Knowledge Pack validator — contracts/validate_pack.py (issue #68, C1).

Validates a Knowledge Pack (an unpacked directory or a .zip) against the
frozen manifest schema in contracts/pack.schema.json (JSON Schema draft
2020-12, the single source of truth — this tool never re-encodes schema
rules by hand) plus three semantic checks the schema cannot express:

  1. per-doc path safety: pack-relative forward-slash paths only; absolute
     paths, backslashes, and ``..``/``.`` segments are rejected with a named
     error echoing the offending path (defense-in-depth ahead of C8/#75);
  2. per-doc sha256 re-hash: every ``docs[].sha256`` must match the actual
     raw bytes (tamper detection, mirroring packtool verify);
  3. missing docs: every declared doc must exist in the pack.

supersedes entries are validated against the schema pattern only; whether a
supersede target may name another pack id is PackManager install policy
(C2/#69, C3/#70) and is deliberately NOT a format-level rule — see
docs/adr/0004-knowledge-packs.md.

Report format is diff-able: one ``FAIL: <instance path>: <message>`` line
per problem (schema errors in schema-error order, then semantic checks in
manifest order), a single ``OK: <n> docs validated`` line on success.

Exit codes: 0 valid; 1 invalid (FAIL lines emitted); 2 usage error (missing
pack path, unreadable schema).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import zipfile
from pathlib import Path
from typing import Dict, List, Optional, Union

try:
    from jsonschema import Draft202012Validator, FormatChecker
except ImportError:  # pragma: no cover - dependency pinned in requirements.txt
    print(
        "FAIL: $: the 'jsonschema' package is required (pip install 'jsonschema>=4.18,<5.0.0')"
    )
    sys.exit(2)

DEFAULT_SCHEMA = Path(__file__).resolve().parent / "pack.schema.json"
PACK_JSON = "pack.json"


class UsageError(Exception):
    """Fatal input problem: report and exit 2."""


class PackSource:
    """Byte-level access to pack entries, from a directory or a zip."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self._zip: Optional[zipfile.ZipFile] = None
        if root.is_file() or str(root).lower().endswith(".zip"):
            if not root.exists():
                raise UsageError(f"pack not found: {root}")
            try:
                self._zip = zipfile.ZipFile(root)
            except zipfile.BadZipFile as error:
                raise UsageError(
                    f"pack zip could not be opened: {root}: {error}"
                ) from error
        elif root.is_dir():
            if not (root / PACK_JSON).exists():
                raise UsageError(
                    f"pack not found (no {PACK_JSON} in directory): {root}"
                )
        else:
            raise UsageError(f"pack not found: {root}")

    def read_entry(self, name: str) -> Optional[bytes]:
        if self._zip is not None:
            try:
                return self._zip.read(name)
            except KeyError:
                return None
        target = self.root / name
        if not target.is_file():
            return None
        return target.read_bytes()

    def close(self) -> None:
        if self._zip is not None:
            self._zip.close()


def fail(problems: List[str], instance_path: str, message: str) -> None:
    problems.append(f"FAIL: {instance_path}: {message}")


def instance_path(prefix: str, key: Union[str, int]) -> str:
    return (
        f"{prefix}[{key}]"
        if isinstance(key, int)
        else f"{prefix}.{key}"
        if prefix != "$"
        else f"$.{key}"
    )


def doc_path_problem(value: str) -> Optional[str]:
    """Mirror packtool's assertSafeDocPath: reject absolute paths, backslashes,
    '..'/'.' segments, and NUL bytes. Returns the problem message or None."""
    if value == "":
        return "doc path must not be empty"
    if "\\" in value:
        return "doc path must use forward slashes (refused)"
    if value.startswith("/") or (len(value) >= 2 and value[1] == ":"):
        return "doc path must be relative (refused)"
    for segment in value.split("/"):
        if segment in ("..", "."):
            return "doc path contains a relative-path segment (refused)"
        if "\x00" in segment:
            return "doc path contains a NUL byte (refused)"
    return None


def schema_errors(manifest: object, validator: Draft202012Validator) -> List[str]:
    problems: List[str] = []
    for error in sorted(
        validator.iter_errors(manifest), key=lambda e: list(e.absolute_path)
    ):
        path = "$"
        for part in error.absolute_path:
            path = instance_path(path, part)
        fail(problems, path, error.message)
    return problems


def semantic_problems(manifest: Dict[str, object], source: PackSource) -> List[str]:
    problems: List[str] = []
    docs = manifest.get("docs")
    if not isinstance(docs, list):
        return problems  # schema already reported the shape problem
    for i, entry in enumerate(docs):
        if not isinstance(entry, dict):
            continue  # schema already reported the shape problem
        path = entry.get("path")
        declared = entry.get("sha256")
        at = f"$.docs[{i}]"
        if not isinstance(path, str) or not isinstance(declared, str):
            continue  # schema already reported the shape problem
        problem = doc_path_problem(path)
        if problem is not None:
            fail(problems, at, f"{path}: {problem}")
            continue
        # zip entries are addressed by exact name (no extraction), so a
        # traversal-style name can never escape the archive.
        bytes_ = source.read_entry(path)
        if bytes_ is None:
            fail(problems, at, f"{path}: doc missing from pack")
            continue
        actual = hashlib.sha256(bytes_).hexdigest()
        if actual != declared:
            fail(
                problems,
                at,
                f"{path}: sha256 mismatch (manifest {declared}, actual {actual})",
            )
    return problems


def validate(pack_path: Path, schema_path: Path) -> int:
    try:
        schema_bytes = schema_path.read_bytes()
    except OSError as error:
        raise UsageError(f"schema could not be read: {schema_path}: {error}") from error
    try:
        schema = json.loads(schema_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise UsageError(f"schema is not valid JSON: {schema_path}: {error}") from error
    validator = Draft202012Validator(schema, format_checker=FormatChecker())

    source = PackSource(pack_path)
    problems: List[str] = []
    docs = 0
    try:
        pack_json_bytes = source.read_entry(PACK_JSON)
        if pack_json_bytes is None:
            fail(problems, "$", f"{PACK_JSON} is missing from the pack")
        else:
            try:
                manifest = json.loads(pack_json_bytes.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                fail(problems, "$", f"{PACK_JSON} is not valid UTF-8 JSON: {error}")
                manifest = None
            if manifest is not None:
                problems.extend(schema_errors(manifest, validator))
                if not problems:
                    assert isinstance(manifest, dict)
                    problems.extend(semantic_problems(manifest, source))
                    if not problems and isinstance(manifest.get("docs"), list):
                        docs = len(manifest["docs"])
    finally:
        source.close()

    for line in problems:
        print(line)
    if problems:
        print(f"invalid: {len(problems)} problem(s)")
        return 1
    print(f"OK: {docs} docs validated")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Validate a Knowledge Pack (directory or .zip) "
        "against contracts/pack.schema.json (issue #68)."
    )
    parser.add_argument(
        "pack", type=Path, help="path to an unpacked pack directory or a pack .zip"
    )
    parser.add_argument(
        "--schema",
        type=Path,
        default=DEFAULT_SCHEMA,
        help=f"path to the manifest schema (default: {DEFAULT_SCHEMA})",
    )
    args = parser.parse_args(argv)
    try:
        return validate(args.pack, args.schema)
    except UsageError as error:
        print(f"error: {error}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
