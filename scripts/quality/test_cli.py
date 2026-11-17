"""CLI contract tests use invented data, never corpus gold or a live service."""
import contextlib
import hashlib
import io
import json
from unittest.mock import patch
import collect
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


class QualityCLI(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pb-quality-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write_json(self, name, value):
        path = self.root / name
        path.write_text(json.dumps(value), encoding="utf-8")
        return path

    def run_cli(self, name, *args):
        result = subprocess.run([sys.executable, str(HERE / name), *map(str, args)],
                                capture_output=True, text=True, encoding="utf-8", timeout=20)
        self.assertTrue(result.stdout.strip(), result.stderr)
        return result.returncode, json.loads(result.stdout)

    def manifest(self, url="https://example.org/fixed.pdf", **extra):
        return self.write_json("manifest.json", {"schema_version": 1, "documents": [{
            "doc_id": "fixture", "family_id": "fixture", "split": "dev",
            "fixed_pdf_url": url, "expected_page_count": 1, **extra}]})

    def test_dry_run_never_creates_cache(self):
        cache = self.root / "cache"
        code, output = self.run_cli("collect.py", "--manifest", self.manifest(), "--cache", cache)
        self.assertEqual(code, 0)
        self.assertEqual(output["status"], "planned")
        self.assertFalse(cache.exists())

    def test_missing_gold_has_no_score_and_required_fails(self):
        prediction = self.write_json("pred.json", {"pages": []})
        code, output = self.run_cli("evaluate.py", "--predictions", prediction)
        self.assertEqual((code, output["status"]), (0, "not_evaluated"))
        self.assertNotIn("metrics", output)
        code, output = self.run_cli("evaluate.py", "--predictions", prediction, "--require-gold")
        self.assertNotEqual(code, 0)
        self.assertEqual(output["status"], "not_evaluated")

    def seed_cache(self, recorded_hash=None):
        cache = self.root / "cache"
        cache.mkdir()
        data = b"%PDF-1.4\nInvented fixture; never corpus input.\n%%EOF\n"
        (cache / "fixture.pdf").write_bytes(data)
        actual = hashlib.sha256(data).hexdigest()
        (cache / "acquisition.json").write_text(json.dumps({"schema_version": 1, "documents": {
            "fixture": {"sha256": recorded_hash or actual, "fixed_pdf_url": "https://example.org/fixed.pdf",
                        "actual_page_count": None, "family_id": "fixture", "split": "dev"}}}), encoding="utf-8")
        return cache, data

    def test_resume_rehashes_and_does_not_touch_existing_pdf(self):
        cache, data = self.seed_cache()
        before = (cache / "fixture.pdf").stat().st_mtime_ns
        code, output = self.run_cli("collect.py", "--manifest", self.manifest(), "--cache", cache,
                                    "--download", "--resume", "--page-counter", "none")
        self.assertEqual(code, 0)
        self.assertEqual(output["results"][0]["status"], "resumed")
        self.assertEqual((cache / "fixture.pdf").read_bytes(), data)
        self.assertEqual((cache / "fixture.pdf").stat().st_mtime_ns, before)

    def test_hash_conflict_never_overwrites(self):
        cache, data = self.seed_cache("0" * 64)
        code, output = self.run_cli("collect.py", "--manifest", self.manifest(), "--cache", cache,
                                    "--download", "--resume")
        self.assertNotEqual(code, 0)
        self.assertIn("refusing overwrite", output["results"][0]["error"])
        self.assertEqual((cache / "fixture.pdf").read_bytes(), data)

    def test_resume_cannot_reassign_a_family_to_holdout(self):
        cache, data = self.seed_cache()
        code, output = self.run_cli("collect.py", "--manifest", self.manifest(split="holdout"), "--cache", cache,
                                    "--download", "--resume")
        self.assertNotEqual(code, 0)
        self.assertIn("family or split changed", output["results"][0]["error"])
        self.assertEqual(output["review_pages"], 0)

    def test_resume_enforces_new_single_file_budget(self):
        cache, data = self.seed_cache()
        code, output = self.run_cli("collect.py", "--manifest", self.manifest(), "--cache", cache,
                                    "--download", "--resume", "--max-file-bytes", "1")
        self.assertNotEqual(code, 0)
        self.assertIn("single-file byte budget", output["results"][0]["error"])
        self.assertEqual((cache / "fixture.pdf").read_bytes(), data)

    def test_budget_and_path_validation_precede_network(self):
        cache, data = self.seed_cache()
        code, output = self.run_cli("collect.py", "--manifest", self.manifest(), "--cache", cache,
                                    "--download", "--resume", "--max-total-bytes", "1")
        self.assertNotEqual(code, 0)
        self.assertIn("exceeds total byte budget", output["error"])
        code, output = self.run_cli("collect.py", "--manifest", self.manifest(doc_id="../escape"))
        self.assertNotEqual(code, 0)
        self.assertEqual(output["error"], "unsafe doc_id")

    def test_stream_limits_and_content_rejection_without_network(self):
        # Replace only the external HTTP transport; exercise the real CLI and disk writes.
        class Response(io.BytesIO):
            def __init__(self, content, headers):
                super().__init__(content)
                self.headers = headers
            def geturl(self):
                return "https://example.org/fixed.pdf"
        cases = [
            (b"%PDF-" + b"x" * 60, {"Content-Type": "application/pdf"}, "stream exceeds", {}),
            (b"<html>error", {"Content-Type": "text/html"}, "unexpected MIME", {}),
            (b"%PDF-fixture", {"Content-Type": "application/pdf", "Content-Length": "20"}, "truncated response", {}),
            (b"%PDF-fixture", {"Content-Type": "application/pdf"}, "mismatches manifest", {"expected_sha256": "0" * 64}),
        ]
        for number, (body, headers, reason, manifest_extra) in enumerate(cases):
            with self.subTest(reason=reason):
                manifest = self.manifest(**manifest_extra)
                cache = self.root / f"rejected-{number}"
                argv = [str(HERE / "collect.py"), "--manifest", str(manifest), "--cache", str(cache),
                        "--download", "--max-file-bytes", "32", "--page-counter", "none"]
                output = io.StringIO()
                with patch.object(sys, "argv", argv), patch("urllib.request.OpenerDirector.open", return_value=Response(body, headers)), contextlib.redirect_stdout(output):
                    code = collect.main()
                result = json.loads(output.getvalue())
                self.assertNotEqual(code, 0)
                self.assertIn(reason, result["results"][0]["error"])
                self.assertFalse(list(cache.glob("*.pdf")))
                self.assertFalse(list(cache.glob("*.part")))

    def gold_fixture(self):
        base = {"source_sha256": "a" * 64, "family_id": "invented", "status": "independently_reviewed",
                "annotator_id": "invented-person-1", "reviewer_id": "invented-person-2"}
        return {"kind": "independent_human_gold", "status": "frozen", "guideline_version": "invented-test-only",
                "pages": [{**base, "page_id": "invented:p1", "text": "A B",
                           "words": [{"text": "A", "bbox": [0, 0, 10, 10]}, {"text": "B", "bbox": [20, 0, 30, 10]}],
                           "reading_order_edges": [["a", "next", "b"]]},
                          {**base, "page_id": "invented:p2", "text": "XY"}]}

    def test_missing_pages_duplicates_and_adjacency_penalized(self):
        gold = self.write_json("gold.json", self.gold_fixture())
        predicted = self.write_json("prediction.json", {"pages": [{"page_id": "invented:p1",
            "source_sha256": "a" * 64, "text": "A B A", "alignment_reviewed_by": "invented-reviewer",
            "words": [{"text": "A", "bbox": [0, 0, 10, 10]}, {"text": "B", "bbox": [20, 0, 30, 10]},
                      {"text": "A", "bbox": [0, 0, 10, 10]}],
            "reading_order_edges": [["a", "next", "b"], ["a", "next", "b"]]}]})
        code, output = self.run_cli("evaluate.py", "--gold", gold, "--predictions", predicted, "--require-gold")
        self.assertEqual(code, 0, output)
        self.assertEqual(output["metrics"]["missing_prediction_pages"], 1)
        self.assertEqual(output["metrics"]["cer_micro"], 0.8)
        self.assertEqual(output["page_scores"][0]["words"]["duplicates"], 1)
        self.assertAlmostEqual(output["page_scores"][0]["reading_order_edges"]["f1"], 2 / 3)
        self.assertEqual(output["page_scores"][0]["formula_edges"]["status"], "not_evaluated")

    def test_source_mismatch_and_duplicate_prediction_pages_rejected(self):
        gold = self.write_json("gold.json", self.gold_fixture())
        pred = {"page_id": "invented:p1", "source_sha256": "b" * 64, "text": "A B"}
        predicted = self.write_json("prediction.json", {"pages": [pred]})
        originals = (gold.read_bytes(), predicted.read_bytes())
        code, output = self.run_cli("evaluate.py", "--gold", gold, "--predictions", predicted)
        self.assertNotEqual(code, 0)
        self.assertIn("source hash mismatch", output["error"])
        self.assertEqual((gold.read_bytes(), predicted.read_bytes()), originals)
        self.write_json("prediction.json", {"pages": [pred, pred]})
        code, output = self.run_cli("evaluate.py", "--gold", gold, "--predictions", predicted)
        self.assertNotEqual(code, 0)
        self.assertIn("duplicate prediction", output["error"])

    def test_relation_scores_require_reviewed_alignment(self):
        gold = self.write_json("gold.json", self.gold_fixture())
        predicted = self.write_json("prediction.json", {"pages": [{"page_id": "invented:p1",
            "source_sha256": "a" * 64, "text": "A B", "reading_order_edges": [["a", "next", "b"]]}]})
        code, output = self.run_cli("evaluate.py", "--gold", gold, "--predictions", predicted)
        self.assertEqual(code, 0)
        self.assertEqual(output["page_scores"][0]["reading_order_edges"]["status"], "not_evaluated")

    def test_same_reviewer_and_unfrozen_gold_rejected(self):
        payload = self.gold_fixture()
        payload["pages"][0]["reviewer_id"] = "invented-person-1"
        gold = self.write_json("gold.json", payload)
        predicted = self.write_json("prediction.json", {"pages": []})
        code, output = self.run_cli("evaluate.py", "--gold", gold, "--predictions", predicted)
        self.assertNotEqual(code, 0)
        self.assertIn("must differ", output["error"])
        payload["status"] = "draft"
        self.write_json("gold.json", payload)
        code, output = self.run_cli("evaluate.py", "--gold", gold, "--predictions", predicted)
        self.assertNotEqual(code, 0)
        self.assertEqual(output["status"], "not_evaluated")


if __name__ == "__main__":
    unittest.main(verbosity=2)
