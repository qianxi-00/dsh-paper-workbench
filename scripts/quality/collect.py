#!/usr/bin/env python
"""Bounded, opt-in public PDF collector. Python standard library only.
Page counting optionally invokes an already-installed PyMuPDF in a subprocess.
Completed files resume by hash; interrupted transfers restart, never append.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from urllib.parse import urlparse
from urllib.request import ProxyHandler, Request, build_opener

DEFAULT_MANIFEST = Path(__file__).resolve().parents[2] / "docs/quality/candidates.json"
DEFAULT_CACHE = (Path(os.environ["LOCALAPPDATA"]) / "Temp" if os.name == "nt" and os.environ.get("LOCALAPPDATA")
                 else Path(tempfile.gettempdir())) / "pb-quality-corpus-5b7bcee5"


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(65536), b""):
            value.update(chunk)
    return value.hexdigest()


def save_json(path, value):
    staging = path.with_suffix(path.suffix + ".tmp")
    staging.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(staging, path)


def page_count(path, method):
    if method == "none":
        return None, "not_requested"
    code = "import fitz,sys; d=fitz.open(sys.argv[1]); assert not d.needs_pass; print(len(d))"
    try:
        result = subprocess.run([sys.executable, "-c", code, str(path)], capture_output=True,
                                text=True, timeout=30)
        count = int(result.stdout.strip())
        if result.returncode == 0 and count > 0:
            return count, "pymupdf"
    except (ValueError, OSError, subprocess.TimeoutExpired):
        pass
    return None, "unknown_parser_unavailable_or_failed"


def load_documents(path):
    payload = json.loads(path.read_text(encoding="utf-8"))
    documents = payload["documents"]
    seen, families = set(), {}
    for row in documents:
        key = row["doc_id"]
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_-]{0,100}", key):
            raise ValueError("unsafe doc_id")
        if key in seen:
            raise ValueError("duplicate doc_id: " + key)
        seen.add(key)
        if row["split"] not in ("dev", "holdout"):
            raise ValueError("invalid split")
        family = row["family_id"]
        if family in families and families[family] != row["split"]:
            raise ValueError("family leaks across splits: " + family)
        families[family] = row["split"]
        if urlparse(row["fixed_pdf_url"]).scheme != "https":
            raise ValueError("PDF URL must use HTTPS")
    return documents


def collect(args):
    documents = load_documents(args.manifest)
    if args.ids:
        requested = set(args.ids.split(","))
        unknown = requested - {row["doc_id"] for row in documents}
        if unknown:
            raise ValueError("unknown ids: " + ",".join(sorted(unknown)))
        documents = [row for row in documents if row["doc_id"] in requested]
    if args.max_total_bytes <= 0 or args.max_file_bytes <= 0:
        raise ValueError("byte budgets must be positive")
    if not args.download:
        return {"status": "planned", "documents": len(documents), "cache": str(args.cache),
                "max_total_bytes": args.max_total_bytes, "max_file_bytes": args.max_file_bytes,
                "network_requests": 0, "note": "Pass --download to acquire PDFs."}, 0
    args.cache.mkdir(parents=True, exist_ok=True)
    if args.cache.is_symlink():
        raise ValueError("cache must not be a symlink")
    lock = args.cache / ".collect.lock"
    lock_fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        os.write(lock_fd, str(os.getpid()).encode("ascii"))
        os.close(lock_fd)
        return collect_locked(args, documents)
    finally:
        lock.unlink(missing_ok=True)


def collect_locked(args, documents):
    index_path = args.cache / "acquisition.json"
    ledger = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {
        "schema_version": 1, "documents": {}}
    records = ledger["documents"]
    used_bytes = sum(p.stat().st_size for p in args.cache.glob("*.pdf"))
    # Total ceiling applies to all PDFs already in the cache plus new downloads.
    if used_bytes > args.max_total_bytes:
        raise ValueError("cache already exceeds total byte budget")
    opener = build_opener(ProxyHandler({"http": args.proxy, "https": args.proxy}))
    results = []
    for row in documents:
        key = row["doc_id"]
        final = args.cache / (key + ".pdf")
        previous = records.get(key)
        try:
            if final.exists():
                if final.is_symlink() or not final.is_file():
                    raise ValueError("unsafe existing cache entry")
                if final.stat().st_size > args.max_file_bytes:
                    raise ValueError("existing file exceeds single-file byte budget")
                actual = digest(final)
                if not previous or previous.get("sha256") != actual:
                    raise ValueError("existing file has missing or mismatching recorded hash; refusing overwrite")
                if previous.get("fixed_pdf_url") != row["fixed_pdf_url"]:
                    raise ValueError("source URL changed for existing cache entry")
                if previous.get("family_id") != row["family_id"] or previous.get("split") != row["split"]:
                    raise ValueError("family or split changed for existing cache entry")
                if row.get("expected_sha256") and actual != row["expected_sha256"]:
                    raise ValueError("existing file mismatches manifest hash; refusing overwrite")
                if not args.resume:
                    raise ValueError("existing file requires --resume")
                results.append({"doc_id": key, "status": "resumed", "sha256": actual})
                continue
            if previous:
                raise ValueError("recorded file is missing; repair cache explicitly before recollecting")
            remaining = min(args.max_file_bytes, args.max_total_bytes - used_bytes)
            if remaining <= 0:
                raise ValueError("total byte budget exhausted")
            request = Request(row["fixed_pdf_url"], headers={"User-Agent": "PaperWorkbenchQuality/1.0",
                                                          "Accept": "application/pdf"})
            with opener.open(request, timeout=args.timeout) as response:
                if urlparse(response.geturl()).scheme != "https":
                    raise ValueError("refusing non-HTTPS redirect")
                length = response.headers.get("Content-Length")
                if length and int(length) > remaining:
                    raise ValueError("Content-Length exceeds file or total byte budget")
                media_type = response.headers.get("Content-Type", "").split(";")[0].lower()
                if media_type not in ("application/pdf", "application/octet-stream", "binary/octet-stream"):
                    raise ValueError("unexpected MIME type: " + media_type)
                fd, part_name = tempfile.mkstemp(prefix=key + "-", suffix=".part", dir=args.cache)
                part = Path(part_name)
                try:
                    size = 0
                    with os.fdopen(fd, "wb") as stream:
                        while True:
                            chunk = response.read(min(65536, remaining - size + 1))
                            if not chunk:
                                break
                            size += len(chunk)
                            if size > remaining:
                                raise ValueError("stream exceeds file or total byte budget")
                            stream.write(chunk)
                    with part.open("rb") as stream:
                        if stream.read(5) != b"%PDF-":
                            raise ValueError("response is not a PDF")
                    if length and size != int(length):
                        raise ValueError("truncated response")
                    sha = digest(part)
                    if row.get("expected_sha256") and sha != row["expected_sha256"]:
                        raise ValueError("download hash mismatches manifest")
                    pages, method = page_count(part, args.page_counter)
                    # Hard-link publication is atomic and fails if final already exists.
                    os.link(part, final)
                    used_bytes += size
                    records[key] = {"doc_id": key, "family_id": row["family_id"], "split": row["split"],
                        "fixed_pdf_url": row["fixed_pdf_url"], "resolved_url": response.geturl(),
                        "sha256": sha, "byte_size": size, "mime_type": media_type,
                        "actual_page_count": pages, "page_count_method": method,
                        "expected_page_count": row.get("expected_page_count"),
                        "page_count_matches_metadata": None if pages is None or row.get("expected_page_count") is None
                            else pages == row["expected_page_count"],
                        "acquired_at": datetime.now(timezone.utc).isoformat(),
                        "human_layout_verified": False, "gold_status": "unannotated"}
                    save_json(index_path, ledger)
                    results.append({"doc_id": key, "status": "downloaded", "bytes": size, "pages": pages})
                finally:
                    part.unlink(missing_ok=True)
        except Exception as error:
            results.append({"doc_id": key, "status": "error", "error": str(error)})
    selected = {row["doc_id"]: row for row in documents}
    trusted = {row["doc_id"] for row in results if row["status"] in ("downloaded", "resumed")}
    checklist = []
    for key, record in records.items():
        if key not in selected or key not in trusted or not record.get("actual_page_count"):
            continue
        for page in range(record["actual_page_count"]):
            checklist.append({"page_id": f"{key}:p{page + 1}", "doc_id": key,
                "family_id": record["family_id"], "split": record["split"], "page_index_0based": page,
                "source_sha256": record["sha256"], "candidate_tags": selected[key].get("candidate_tags", []),
                "verified_tags": [], "status": "unannotated", "annotator_id": None,
                "reviewer_id": None, "gold_selected": False})
    save_json(args.cache / "pages-to-review.json", {"schema_version": 1, "status": "unannotated",
                                                   "pages": checklist})
    failed = any(row["status"] == "error" for row in results)
    report = {"status": "partial" if failed else "acquired", "results": results,
              "cache_pdf_bytes": used_bytes, "review_pages": len(checklist),
              "gold_status": "unannotated", "human_verified_pages": 0}
    save_json(args.cache / "last-collection.json", report)
    return report, 1 if failed else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--cache", type=Path, default=DEFAULT_CACHE)
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--ids", help="Comma-separated doc IDs")
    parser.add_argument("--max-total-bytes", type=int, default=150_000_000)
    parser.add_argument("--max-file-bytes", type=int, default=25_000_000)
    parser.add_argument("--proxy", default="http://127.0.0.1:7897")
    parser.add_argument("--timeout", type=int, default=30)
    parser.add_argument("--page-counter", choices=("pymupdf", "none"), default="pymupdf")
    args = parser.parse_args()
    try:
        result, code = collect(args)
    except Exception as error:
        result, code = {"status": "error", "error": str(error)}, 1
    print(json.dumps(result, ensure_ascii=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
