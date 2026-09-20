"""Knowledge Pack lifecycle manager (Workstream C2, issue #69).

Installs ``pack.json``-conformant Knowledge Packs (format frozen by C1,
``contracts/pack.schema.json`` + ``docs/adr/0004-knowledge-packs.md``) into
the ChromaDB ``VectorStore`` with content-hash identity, and manages the
install / supersede / rollback / remove lifecycle in a JSON registry
(``pack_registry.json``) written alongside the store metadata.

Identity (normative per ADR-0004 "Chunk identity")::

    doc_id      = sha256(raw doc bytes)
    chunk_id    = sha256(doc_sha256 + ":" + chunk_index + ":" + normalized_text)
    normalized_text = CRLF -> LF (bare CR untouched), trailing horizontal
                      whitespace stripped per line

The "``:``" separators are part of the frozen formula; these functions
byte-match the shipped interop implementations
(``contracts/tests/store-interop/run_interop.py``, ``packtool/build/chunk.ts``).

Install policy (owned by C2 per ADR-0004 "Supersede, upgrade, and rollback
semantics"; recorded in the ADR's C2 policy section):

- same ``id``, higher version than the active install -> implicit upgrade
  (no ``supersedes`` entry required);
- same ``id``, equal version -> refused (remove first); lower -> refused
  (use ``rollback``);
- ``supersedes`` entries naming an INSTALLED foreign ``id@version`` are
  honored: that version is deactivated and its chunks deleted (its files are
  retained per ADR-0004); entries naming nothing installed are recorded and
  warn.

File layout: ``install(pack_path)`` treats ``pack_path`` as the SOURCE only.
The pack tree is copied into the managed per-version directory
``<packs_root>/<pack_id>/<version>/`` and the registry records that managed
path as ``install_path``. FOLDER-FORM packs only: a ``.zip`` source is
refused with :class:`PackManagerError` — zip ingestion (and prebuilt
``index.sqlite`` consumption) is the C6 packtool / C8 hardening surface.
Deactivation (implicit upgrade or supersede) retains managed files; only
``remove`` deletes them (ADR-0004: "never physically delete on supersede").

Atomicity: ordering is validate -> copy -> chunk/embed -> Chroma write ->
registry commit, under the registry lock. Content-derived ids make retries
idempotent: a failure after the Chroma write but before the registry commit
leaves chunks with no registry row, and re-running install reproduces
identical ids (``on_conflict="replace"`` absorbs any residue).

Wiring note (issue #69 exit gate): at merge time no HTTP route or production
module calls PackManager; the first wired consumer is the Documents-page
pack management surface (C7, issue #74).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from jsonschema import Draft202012Validator, FormatChecker

from contracts.validate_pack import (
    PackSource,
    UsageError,
    schema_errors,
    semantic_problems,
)

logger = logging.getLogger(__name__)

_SCHEMA_PATH = Path(__file__).resolve().parent / "contracts" / "pack.schema.json"

_REGISTRY_VERSION = 1

# Module-level (not instance-level): two PackManager instances over the same
# db_path share one pack_registry.json and one Chroma collection, so the
# registry read-modify-write critical section must be process-global.
_registry_lock = threading.RLock()


class PackManagerError(Exception):
    """Raised for refused or failed pack lifecycle operations."""


def normalize_text(text: str) -> str:
    """ADR-0004 normalization: CRLF -> LF, trailing horizontal whitespace
    stripped per line. Bare CR is intentionally NOT normalized."""
    return re.sub(r"[ \t]+$", "", text.replace("\r\n", "\n"), flags=re.MULTILINE)


def doc_id_from_bytes(raw: bytes) -> str:
    """sha256 of raw doc bytes, lowercase hex (ADR-0004 doc identity)."""
    return hashlib.sha256(raw).hexdigest()


def content_hash_of(normalized: str) -> str:
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def chunk_id_of(doc_sha256: str, chunk_index: int, normalized_text: str) -> str:
    """ADR-0004 chunk identity; the ':' separators are part of the formula."""
    payload = f"{doc_sha256}:{chunk_index}:{normalized_text}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def _version_key(version: str) -> Tuple[int, int, int, Tuple[int, tuple]]:
    """Semver 2.0.0 sort key (section 11): numeric triple, then pre-release
    (a pre-release sorts BELOW its release; numeric identifiers compare
    numerically and sort below alphanumeric ones)."""
    core, _, _build = version.partition("+")
    core, _, pre = core.partition("-")
    major_s, minor_s, patch_s = core.split(".")
    major, minor, patch = int(major_s), int(minor_s), int(patch_s)
    if not pre:
        pre_key: Tuple[int, tuple] = (1, ())
    else:
        # Semver 11.4: numeric identifiers compare numerically and have LOWER
        # precedence than alphanumeric ones; longer identifier sets win on
        # equal prefixes (tuple comparison handles both).
        ids = tuple(
            (0, int(part), "") if part.isdigit() else (1, 0, part)
            for part in pre.split(".")
        )
        pre_key = (0, ids)
    return (major, minor, patch, pre_key)


def extract_doc_text(raw: bytes, mime: str) -> str:
    """Extract the chunkable text from a doc's raw bytes by declared mime."""
    if mime == "application/json":
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError, RecursionError) as error:
            raise PackManagerError(f"doc is not valid JSON: {error}") from error
        if not isinstance(data, dict) or not isinstance(data.get("text"), str):
            raise PackManagerError("JSON doc must be an object with a string 'text'")
        return data["text"]
    if mime.startswith("text/"):
        try:
            return raw.decode("utf-8")
        except UnicodeDecodeError as error:
            raise PackManagerError(f"text doc is not valid UTF-8: {error}") from error
    raise PackManagerError(
        f"unsupported doc mime {mime!r}; prebuilt-index packs are the C6 path"
    )


def split_words(text: str, size: int, overlap: int) -> List[str]:
    """fixed-words windows over whitespace-separated words, per the manifest
    chunking block. Returns [text] unchanged when it fits within size."""
    words = text.split()
    if len(words) <= size:
        return [text]
    if overlap >= size:
        raise PackManagerError("chunking overlap must be smaller than size")
    pieces: List[str] = []
    step = size - overlap
    start = 0
    while start < len(words):
        window = words[start : start + size]
        pieces.append(normalize_text(" ".join(window)))
        if start + size >= len(words):
            break
        start += step
    return pieces


@dataclass
class PackRecord:
    """One installed pack version, as stored in the registry."""

    pack_id: str
    version: str
    active: bool
    install_path: str
    supersedes: List[str] = field(default_factory=list)
    docs: Dict[str, Dict[str, str]] = field(default_factory=dict)
    # C4 (issue #71): manifest published_at, persisted additively so the
    # recency prior can rank without re-reading managed manifests. Registries
    # written before C4 load as None -> neutral multiplier.
    published_at: Optional[str] = None
    # C7 (issue #74): manifest display fields surfaced by GET /packs, persisted
    # additively with the same None-fallback pattern for pre-C7 registry rows.
    name: Optional[str] = None
    source_class: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        return {
            "pack_id": self.pack_id,
            "version": self.version,
            "active": self.active,
            "install_path": self.install_path,
            "supersedes": list(self.supersedes),
            "docs": {path: dict(info) for path, info in self.docs.items()},
            "published_at": self.published_at,
            "name": self.name,
            "source_class": self.source_class,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "PackRecord":
        return cls(
            pack_id=data["pack_id"],
            version=data["version"],
            active=bool(data["active"]),
            install_path=data["install_path"],
            supersedes=list(data.get("supersedes", [])),
            docs={path: dict(info) for path, info in data.get("docs", {}).items()},
            published_at=data.get("published_at"),
            name=data.get("name"),
            source_class=data.get("source_class"),
        )


@dataclass
class InstallResult:
    pack_id: str
    version: str
    source_path: str
    install_path: str
    docs_installed: int
    chunks_added: int
    replaced_doc_ids: List[str]
    superseded: List[str]
    warnings: List[str]


class PackManager:
    """Lifecycle manager over a VectorStore; see module docstring."""

    def __init__(self, store, packs_root=None) -> None:
        self.store = store
        self.db_path = Path(store.db_path)
        self.packs_root = (
            Path(packs_root) if packs_root is not None else self.db_path / "packs"
        )
        self.packs_root.mkdir(parents=True, exist_ok=True)
        self.registry_path = self.db_path / "pack_registry.json"
        self._validator: Optional[Draft202012Validator] = None

    # ------------------------------------------------------------------ #
    # registry plumbing
    # ------------------------------------------------------------------ #

    def _rows(self) -> List[Dict[str, Any]]:
        if not self.registry_path.exists():
            return []
        try:
            data = json.loads(self.registry_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
            raise PackManagerError(f"pack registry unreadable: {error}") from error
        if data.get("version") != _REGISTRY_VERSION:
            raise PackManagerError(
                f"unsupported pack registry version: {data.get('version')!r}"
            )
        return list(data.get("packs", []))

    def _save_rows(self, rows: List[Dict[str, Any]]) -> None:
        payload = {"version": _REGISTRY_VERSION, "packs": rows}
        tmp = self.registry_path.with_suffix(".json.tmp")
        try:
            tmp.write_text(
                json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
            )
            tmp.replace(self.registry_path)
        except OSError as error:
            raise PackManagerError(f"pack registry write failed: {error}") from error

    def _find(self, rows, pack_id: str, version: Optional[str] = None):
        for row in rows:
            if row["pack_id"] == pack_id and (
                version is None or row["version"] == version
            ):
                return row
        return None

    def active_pack_claims(self) -> List[Dict[str, Any]]:
        """Active pack claims for the C4 recency/precedence prior (issue #71).

        One entry per active registry row: pack_id, version, published_at
        (None for pre-C4 registries -> neutral multiplier) and the doc shas
        that version ships. A chunk is "claimed" iff its doc_id appears in
        an active row's doc shas; chunks carrying pack metadata that no
        active row claims are orphans of a superseded/removed version and
        the ranking layer excludes them (defense-in-depth against a
        PackManager delete bug — the storage layer already deletes on
        supersede).
        """
        claims: List[Dict[str, Any]] = []
        for row in self._rows():
            if not row.get("active"):
                continue
            claims.append(
                {
                    "pack_id": row["pack_id"],
                    "version": row["version"],
                    "published_at": row.get("published_at"),
                    # Explicit flag: the prior's precedence contract consumes
                    # the same claim shape as the pure-function tests.
                    "active": True,
                    "doc_shas": [
                        info.get("doc_id")
                        for info in (row.get("docs") or {}).values()
                        if info.get("doc_id")
                    ],
                }
            )
        return claims

    # ------------------------------------------------------------------ #
    # validation
    # ------------------------------------------------------------------ #

    def _validator_for(self) -> Draft202012Validator:
        if self._validator is None:
            schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
            self._validator = Draft202012Validator(
                schema, format_checker=FormatChecker()
            )
        return self._validator

    def _validated_manifest(self, pack_path: Path) -> Dict[str, Any]:
        """Schema + semantic validation via the frozen C1 validator building
        blocks (no re-encoded rules; doc bytes hash-checked against the
        manifest by semantic_problems)."""
        try:
            source = PackSource(pack_path)
        except UsageError as error:
            raise PackManagerError(str(error)) from error
        try:
            manifest_bytes = source.read_entry("pack.json")
            if manifest_bytes is None:
                raise PackManagerError(
                    f"{pack_path}: pack.json is missing from the pack"
                )
            try:
                manifest = json.loads(manifest_bytes.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as error:
                raise PackManagerError(
                    f"{pack_path}: pack.json is not valid UTF-8 JSON: {error}"
                ) from error
            problems: List[str] = list(schema_errors(manifest, self._validator_for()))
            problems.extend(semantic_problems(manifest, source))
        except UsageError as error:
            raise PackManagerError(str(error)) from error
        finally:
            source.close()
        if problems:
            raise PackManagerError("pack failed validation: " + "; ".join(problems))
        return manifest

    # ------------------------------------------------------------------ #
    # chunking / ingestion
    # ------------------------------------------------------------------ #

    def _build_chunks(
        self, install_dir: Path, manifest: Dict[str, Any]
    ) -> List[Dict[str, Any]]:
        """Build add_chunks_with_embeddings payloads (without embeddings).

        Non-fixed-words strategies are accepted only for under-size docs
        (single chunk); over-size docs on those strategies refuse with
        PackManagerError - prebuilt-index packs are the C6 path. The same
        applies to unsupported doc mimes.
        """
        chunking = manifest.get("chunking", {})
        strategy = chunking.get("strategy", "fixed-words")
        size = int(chunking.get("size", 256))
        overlap = int(chunking.get("overlap", 0))
        pack_id = manifest["id"]
        chunks: List[Dict[str, Any]] = []
        for entry in manifest["docs"]:
            rel_path = entry["path"]
            try:
                raw = (install_dir / rel_path).read_bytes()
            except OSError as error:
                raise PackManagerError(
                    f"doc unreadable: {rel_path}: {error}"
                ) from error
            doc_sha = doc_id_from_bytes(raw)
            text = extract_doc_text(raw, entry.get("mime", "text/plain"))
            if strategy == "fixed-words":
                pieces = split_words(text, size, overlap)
            elif len(text.split()) <= size:
                # under-size docs are one chunk regardless of strategy
                pieces = [normalize_text(text)]
            else:
                raise PackManagerError(
                    f"chunking strategy {strategy!r} over size is not built here;"
                    " ship a prebuilt index (C6 packtool) for this pack"
                )
            for index, piece in enumerate(pieces):
                chunk_text = normalize_text(piece)
                chunks.append(
                    {
                        "chunk_id": chunk_id_of(doc_sha, index, chunk_text),
                        "text": chunk_text,
                        "metadata": {
                            "source": f"{pack_id}/{rel_path}",
                            "doc_id": doc_sha,
                            "chunk_index": index,
                            "source_path": str(install_dir / rel_path),
                            "pack_id": pack_id,
                            "pack_version": manifest["version"],
                            "content_hash": content_hash_of(chunk_text),
                            # C4 (issue #71): age for the recency prior; the
                            # manifest value is the only published_at source
                            # at ranking time (ADR-0004: not the file mtime).
                            "pack_published_at": manifest.get("published_at"),
                        },
                    }
                )
        return chunks

    def _embed_and_add(self, chunks: List[Dict[str, Any]]) -> int:
        texts = [chunk["text"] for chunk in chunks]
        embeddings = self.store.embedder.encode(texts)
        if not isinstance(embeddings, list):
            embeddings = list(embeddings)
        # No mock broadcast here: an embedder that cannot produce one vector
        # per chunk fails the install explicitly, so a pack is never recorded
        # as complete with borrowed or missing vectors.
        if len(embeddings) != len(texts):
            raise PackManagerError(
                f"embedder returned {len(embeddings)} vectors for "
                f"{len(texts)} chunks; refusing partial install"
            )
        payload = [dict(chunk, embedding=emb) for chunk, emb in zip(chunks, embeddings)]
        self.store.add_chunks_with_embeddings(payload, on_conflict="replace")
        return len(payload)

    def _docs_map(self, manifest: Dict[str, Any]) -> Dict[str, Dict[str, str]]:
        # doc identity == sha256 of raw bytes == the (hash-verified) declared sha
        return {
            entry["path"]: {
                "doc_sha256": entry["sha256"],
                "doc_id": entry["sha256"],
            }
            for entry in manifest["docs"]
        }

    # ------------------------------------------------------------------ #
    # state transitions
    # ------------------------------------------------------------------ #

    def _deactivate(self, rows: List[Dict[str, Any]], row: Dict[str, Any]) -> List[str]:
        """Delete a version's chunks from the live collection; files retained."""
        removed: List[str] = []
        for info in row.get("docs", {}).values():
            if self.store.delete_document(info["doc_id"]):
                removed.append(info["doc_id"])
            else:
                # Single-user semantics: deactivate proceeds; the orphan is
                # logged and absorbed by the next reinstall of this version
                # (content-hash ids make re-ingest byte-identical).
                logger.warning(
                    "pack %s@%s: chunk delete returned False for doc %s;"
                    " row deactivated but chunks may remain in the collection",
                    row["pack_id"],
                    row["version"],
                    info["doc_id"],
                )
        row["active"] = False
        return removed

    def _activate(self, row: Dict[str, Any]) -> None:
        """Bring an installed-but-inactive version's chunks back live by
        re-ingesting from its retained managed dir (content-hash ids make
        this byte-identical to the original install)."""
        manifest = self._validated_manifest(Path(row["install_path"]))
        chunks = self._build_chunks(Path(row["install_path"]), manifest)
        self._embed_and_add(chunks)
        row["active"] = True

    # ------------------------------------------------------------------ #
    # public lifecycle API
    # ------------------------------------------------------------------ #

    def install(self, pack_path) -> InstallResult:
        source = Path(pack_path)
        if not source.is_dir():
            # PackSource would validate a zip fine, but install/ingest below
            # require a folder on disk; refuse cleanly instead of crashing.
            raise PackManagerError(
                f"{source}: folder-form packs only; zip ingestion (and "
                "prebuilt indexes) land with C6 packtool / C8 hardening"
            )
        with _registry_lock:
            manifest = self._validated_manifest(source)

            # C8 (issue #75): hardening gate — opt-in signature verification
            # and embedding/schema compatibility, both fail-closed BEFORE any
            # copy, chunk, or insert so a refused pack leaves no partial
            # state. Lazy imports keep the pack_extract <-> pack_manager
            # import graph acyclic.
            from config import get_settings
            from pack_extract import (
                check_pack_compat,
                check_signature_gate,
                limits_from_settings,
            )

            limits = limits_from_settings()
            check_signature_gate(manifest, (source / "pack.json").read_bytes(), limits)
            check_pack_compat(manifest, get_settings().rag_embedding_model)

            pack_id = manifest["id"]
            version = manifest["version"]

            doc_paths = [entry["path"] for entry in manifest["docs"]]
            if len(doc_paths) != len(set(doc_paths)):
                raise PackManagerError(
                    f"{pack_path}: duplicate docs[].path entries in manifest"
                )

            rows = self._rows()
            own_active = [r for r in rows if r["pack_id"] == pack_id and r["active"]]
            if own_active:
                active_version = own_active[0]["version"]
                if _version_key(version) < _version_key(active_version):
                    raise PackManagerError(
                        f"refusing downgrade of {pack_id}: {active_version} is "
                        "installed and active; use rollback"
                    )
                if _version_key(version) == _version_key(active_version):
                    raise PackManagerError(
                        f"{pack_id}@{version} is already installed and active; "
                        "remove it first"
                    )

            targets: List[Dict[str, Any]] = []
            warnings: List[str] = []
            for entry in manifest.get("supersedes", []):
                target_id, _, target_version = entry.partition("@")
                target = self._find(rows, target_id, target_version)
                if target is None:
                    warnings.append(
                        f"supersedes entry {entry} names no installed pack version;"
                        " recorded on the new row only"
                    )
                elif target not in targets:
                    targets.append(target)

            # outgoing rows: the prior same-id active version (any transition
            # direction — implicit upgrade is the common case) + supersede targets
            outgoing: List[Dict[str, Any]] = list(own_active)
            for target in targets:
                if target not in outgoing:
                    outgoing.append(target)

            # managed copy; source path is never referenced again.
            # Refuse symlinked sources BEFORE copying (parity with the Node
            # install path's copyPackTreeRejectingLinks): default copytree
            # would follow links and copy their targets into the managed dir.
            for root, dirs, files in os.walk(source):
                for entry in dirs + files:
                    full = os.path.join(root, entry)
                    if os.path.islink(full):
                        raise PackManagerError(
                            f"{source}: refusing symlink/junction in pack source: {full}"
                        )
            managed = self.packs_root / pack_id / version
            try:
                if managed.exists():
                    shutil.rmtree(managed)  # residue of a failed earlier attempt
                shutil.copytree(source, managed)
            except OSError as error:
                raise PackManagerError(
                    f"failed to stage managed copy of {pack_id}@{version}: {error}"
                ) from error

            new_docs = self._docs_map(manifest)

            # delete-before-reingest: for each outgoing row, drop docs whose
            # content changed at the same manifest path, or which the new
            # manifest no longer carries. Content-identical docs keep their
            # chunks (same ids as the incoming insert; replace mode dedupes).
            replaced_doc_ids: List[str] = []
            for row in outgoing:
                for path, info in row.get("docs", {}).items():
                    incoming = new_docs.get(path)
                    if incoming is None or incoming["doc_sha256"] != info["doc_sha256"]:
                        if self.store.delete_document(info["doc_id"]):
                            replaced_doc_ids.append(info["doc_id"])

            chunks = self._build_chunks(managed, manifest)
            added = self._embed_and_add(chunks)

            superseded_names: List[str] = []
            for row in outgoing:
                row["active"] = False
                superseded_names.append(f"{row['pack_id']}@{row['version']}")

            # drop any residue row for this exact id@version (failed attempt)
            rows = [
                r
                for r in rows
                if not (r["pack_id"] == pack_id and r["version"] == version)
            ]
            rows.append(
                {
                    "pack_id": pack_id,
                    "version": version,
                    "active": True,
                    "install_path": str(managed),
                    "supersedes": list(manifest.get("supersedes", [])),
                    "docs": new_docs,
                    # C4 (issue #71): additive; queried per-keystroke by the
                    # recency prior instead of re-reading the manifest.
                    "published_at": manifest.get("published_at"),
                    # C7 (issue #74): display fields for GET /packs.
                    "name": manifest.get("name"),
                    "source_class": manifest.get("source_class"),
                }
            )
            self._save_rows(rows)
            for warning in warnings:
                logger.warning("install %s@%s: %s", pack_id, version, warning)
            logger.info(
                "installed pack %s@%s (%d chunks, %d doc(s)) from %s",
                pack_id,
                version,
                added,
                len(manifest["docs"]),
                source,
            )

            return InstallResult(
                pack_id=pack_id,
                version=version,
                source_path=str(source),
                install_path=str(managed),
                docs_installed=len(manifest["docs"]),
                chunks_added=added,
                replaced_doc_ids=replaced_doc_ids,
                superseded=superseded_names,
                warnings=warnings,
            )

    def supersede(self, pack_id: str, from_version: str, to_version: str) -> None:
        """Deactivate ``from_version`` and make ``to_version`` live, both of
        which must already be installed. Symmetric with :meth:`rollback`."""
        with _registry_lock:
            rows = self._rows()
            from_row = self._find(rows, pack_id, from_version)
            to_row = self._find(rows, pack_id, to_version)
            if from_row is None or to_row is None:
                raise PackManagerError(
                    f"supersede requires both versions installed: "
                    f"{pack_id}@{from_version} and {pack_id}@{to_version}"
                )
            if not to_row["active"]:
                self._activate(to_row)
            if from_row is not to_row and from_row["active"]:
                self._deactivate(rows, from_row)
            self._save_rows(rows)

    def rollback(self, pack_id: str, to_version: str) -> None:
        """Reactivate a previously superseded version and deactivate the
        current active one."""
        with _registry_lock:
            rows = self._rows()
            to_row = self._find(rows, pack_id, to_version)
            if to_row is None:
                raise PackManagerError(f"{pack_id}@{to_version} is not installed")
            current = [r for r in rows if r["pack_id"] == pack_id and r["active"]]
            if current and current[0] is to_row:
                raise PackManagerError(
                    f"{pack_id}@{to_version} is already the active version"
                )
            for row in current:
                self._deactivate(rows, row)
            if not to_row["active"]:
                self._activate(to_row)
            self._save_rows(rows)

    def remove(self, pack_id: str, version: Optional[str] = None) -> int:
        """Irreversibly delete managed files, live chunks, and registry rows.
        Returns the number of pack versions removed."""
        with _registry_lock:
            rows = self._rows()
            victims = [
                r
                for r in rows
                if r["pack_id"] == pack_id
                and (version is None or r["version"] == version)
            ]
            if not victims:
                raise PackManagerError(
                    f"nothing installed matches {pack_id}"
                    + (f"@{version}" if version else "")
                )
            for row in victims:
                install_path = Path(row["install_path"])
                if install_path.exists():
                    try:
                        shutil.rmtree(install_path)
                    except OSError as error:
                        raise PackManagerError(
                            f"failed to delete managed dir {install_path}: {error}"
                        ) from error
                for info in row.get("docs", {}).values():
                    self.store.delete_document(info["doc_id"])
            remaining = [r for r in rows if r not in victims]
            self._save_rows(remaining)
            logger.info("removed pack %s (%d version(s))", pack_id, len(victims))
            return len(victims)

    def list_installed(self) -> List[PackRecord]:
        with _registry_lock:
            return [PackRecord.from_dict(row) for row in self._rows()]  # type: ignore[arg-type]
