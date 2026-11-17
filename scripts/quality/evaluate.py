#!/usr/bin/env python
"""Read-only evaluator for independent, reviewed page gold; no gold means no scores.
Input JSON uses page_id, source_sha256, text, words [{text,bbox}], and optional
relation arrays (reading_order_edges, caption_edges, table_edges, formula_edges).
Relation endpoints are IDs from a separately human-reviewed alignment, not an
automatic parser's own assertions. Empty arrays explicitly mean annotated-empty.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import sys
import unicodedata

RELATIONS = ("reading_order_edges", "caption_edges", "table_edges", "formula_edges")


def normalized(text):
    return unicodedata.normalize("NFC", text.replace("\r\n", "\n"))


def distance(left, right):
    if len(left) < len(right):
        left, right = right, left
    previous = list(range(len(right) + 1))
    for i, a in enumerate(left, 1):
        current = [i]
        for j, b in enumerate(right, 1):
            current.append(min(current[-1] + 1, previous[j] + 1, previous[j - 1] + (a != b)))
        previous = current
    return previous[-1]


def ratio(a, b):
    return a / b if b else None


def box_iou(a, b):
    overlap = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - overlap
    return overlap / union if union else 0


def validate_words(words):
    for word in words:
        box = word["bbox"]
        if not isinstance(word["text"], str) or len(box) != 4 or not all(
                isinstance(x, (int, float)) and math.isfinite(x) for x in box):
            raise ValueError("invalid word text or bbox")
        if box[2] <= box[0] or box[3] <= box[1]:
            raise ValueError("word bbox must have positive area")


def words_score(gold, predicted):
    validate_words(gold)
    validate_words(predicted)
    # Maximum bipartite matching avoids rewarding repeated predicted instances.
    neighbors = [[i for i, expected in enumerate(gold)
                  if normalized(word["text"]) == normalized(expected["text"])
                  and box_iou(word["bbox"], expected["bbox"]) >= 0.5] for word in predicted]
    matches = {}
    def augment(index, seen):
        for target in neighbors[index]:
            if target in seen:
                continue
            seen.add(target)
            if target not in matches or augment(matches[target], seen):
                matches[target] = index
                return True
        return False
    for index in range(len(predicted)):
        augment(index, set())
    assigned = set(matches.values())
    duplicated = sum(bool(neighbors[i]) and i not in assigned for i in range(len(predicted)))
    return {"matched": len(matches), "gold": len(gold), "predicted": len(predicted),
            "duplicates": duplicated, "recall": ratio(len(matches), len(gold)),
            "precision": ratio(len(matches), len(predicted)),
            "duplicate_rate": ratio(duplicated, len(predicted))}


def edges_score(gold, predicted):
    def as_counter(items):
        if any(not isinstance(edge, list) or len(edge) != 3 or
               not all(isinstance(part, str) for part in edge) for edge in items):
            raise ValueError("edges must be [from_id, relation, to_id] triples")
        return Counter(tuple(edge) for edge in items)
    expected, actual = as_counter(gold), as_counter(predicted)
    tp = sum((expected & actual).values())
    n_gold, n_predicted = sum(expected.values()), sum(actual.values())
    return {"tp": tp, "gold": n_gold, "predicted": n_predicted,
            "precision": ratio(tp, n_predicted), "recall": ratio(tp, n_gold),
            "f1": ratio(2 * tp, n_gold + n_predicted)}


def evaluate(args):
    if not args.gold or not args.gold.exists():
        return {"status": "not_evaluated", "reason": "independent gold is absent"}, int(args.require_gold)
    gold = json.loads(args.gold.read_text(encoding="utf-8"))
    predicted = json.loads(args.predictions.read_text(encoding="utf-8"))
    if gold.get("kind") != "independent_human_gold" or gold.get("status") != "frozen":
        return {"status": "not_evaluated", "reason": "gold must be independent_human_gold and frozen"}, 1
    if not gold.get("guideline_version") or not gold.get("pages"):
        raise ValueError("gold needs guidelines and at least one page")
    gold_hash = hashlib.sha256(args.gold.read_bytes()).hexdigest()
    gpages, ppages = {}, {}
    for page in gold["pages"]:
        key = page["page_id"]
        if key in gpages:
            raise ValueError("duplicate gold page_id")
        if page.get("status") != "independently_reviewed" or not page.get("annotator_id") or not page.get("reviewer_id"):
            raise ValueError("every gold page needs independent review metadata")
        if page["annotator_id"] == page["reviewer_id"]:
            raise ValueError("annotator and reviewer must differ")
        if not page.get("source_sha256") or not isinstance(page.get("text"), str):
            raise ValueError("gold page needs source hash and text")
        gpages[key] = page
    for page in predicted.get("pages", []):
        if page["page_id"] in ppages:
            raise ValueError("duplicate prediction page_id")
        ppages[page["page_id"]] = page
    extra = sorted(set(ppages) - set(gpages))
    if extra:
        raise ValueError("prediction contains pages outside gold: " + ",".join(extra[:5]))
    scores = []
    for key, page in gpages.items():
        pred = ppages.get(key)
        missing = pred is None
        pred = pred or {"text": "", "words": []}
        if not missing and pred.get("source_sha256") != page["source_sha256"]:
            raise ValueError("prediction source hash mismatch: " + key)
        expected, actual = normalized(page["text"]), normalized(pred.get("text", ""))
        if max(len(expected), len(actual)) > args.max_page_chars:
            raise ValueError("page text exceeds configured CER work limit")
        row = {"page_id": key, "missing_prediction": missing, "characters": len(expected),
               "edit_distance": distance(expected, actual)}
        row["cer"] = ratio(row["edit_distance"], len(expected))
        if "words" in page:
            row["words"] = words_score(page["words"], pred.get("words", []))
        for name in RELATIONS:
            if name not in page:
                row[name] = {"status": "not_evaluated", "reason": "relation gold absent"}
            elif not missing and not pred.get("alignment_reviewed_by"):
                row[name] = {"status": "not_evaluated", "reason": "human-reviewed ID alignment absent"}
            else:
                row[name] = edges_score(page[name], pred.get(name, []))
        scores.append(row)
    edits, chars = sum(p["edit_distance"] for p in scores), sum(p["characters"] for p in scores)
    return {"status": "evaluated", "gold_sha256": gold_hash, "guideline_version": gold["guideline_version"],
            "normalization": "NFC and CRLF-to-LF only", "word_match": "exact NFC text and bbox IoU >= 0.5",
            "provenance_note": "Review declarations require external human audit; this tool cannot authenticate people.",
            "metrics": {"cer_micro": ratio(edits, chars), "characters": chars, "edits": edits,
                        "pages": len(scores), "missing_prediction_pages": sum(p["missing_prediction"] for p in scores)},
            "page_scores": scores}, 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--gold", type=Path)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--require-gold", action="store_true")
    parser.add_argument("--max-page-chars", type=int, default=20000)
    args = parser.parse_args()
    try:
        result, code = evaluate(args)
    except Exception as error:
        result, code = {"status": "error", "error": str(error)}, 1
    print(json.dumps(result, ensure_ascii=True))
    return code


if __name__ == "__main__":
    raise SystemExit(main())
