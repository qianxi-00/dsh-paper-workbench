#!/usr/bin/env python
"""Reproduce the researched candidate manifest; no network and no PDF downloads."""
import json
from pathlib import Path

JCOMMIT = "585343b06f82ed9684c4dfc2731b7212a9b322f6"
PCOMMIT = "a6e7a82d46bf2f2e91bbb1f611453b53041007ef"
JMLR = [
    ("18-080", "Approximation Bounds for Hierarchical Clustering: Average Linkage, Bisecting K-means, and Local Search", 36, ["single_column", "formula"]),
    ("19-1030", "The Brier Score under Administrative Censoring: Problems and a Solution", 26, ["single_column", "formula", "vector_figure"]),
    ("20-1206", "Bayesian Spiked Laplacian Graphs", 35, ["single_column", "formula", "vector_figure"]),
    ("20-1310", "Efficient Structure-preserving Support Tensor Train Machine", 22, ["single_column", "formula", "table"]),
    ("20-1321", "Cluster-Specific Predictions with Multi-Task Gaussian Processes", 49, ["single_column", "formula", "vector_figure"]),
    ("20-238", "On Distance and Kernel Measures of Conditional Dependence", 16, ["single_column", "formula"]),
    ("21-0321", "Python package for causal discovery based on LiNGAM", 8, ["single_column"]),
    ("21-1518", "HiClass: a Python Library for Local Hierarchical Classification Compatible with Scikit-learn", 17, ["single_column", "vector_figure", "table"]),
    ("22-0142", "Quantus: An Explainable AI Toolkit for Responsible Evaluation of Neural Network Explanations and Beyond", 11, ["single_column", "vector_figure", "table"]),
    ("22-0567", "Benchmarking Graph Neural Networks", 48, ["single_column", "formula", "vector_figure", "table"]),
]
PMLR = [
    ("abad-rocamora24a", "Revisiting Character-level Adversarial Attacks for Language Models", 1, 30, ["double_column", "table"]),
    ("abe24a", "Adaptively Perturbed Mirror Descent for Learning in Games", 31, 80, ["double_column", "formula"]),
    ("abhyankar24a", "InferCept: Efficient Intercept Support for Augmented Large Language Model Inference", 81, 95, ["double_column", "spanning_columns", "vector_figure", "table"]),
    ("acharya24a", "Balancing Feature Similarity and Label Variability for Optimal Size-Aware One-shot Subset Selection", 96, 116, ["double_column", "formula", "table"]),
    ("achituve24a", "Bayesian Uncertainty for Gradient Aggregation in Multi-Task Learning", 117, 134, ["double_column", "formula", "vector_figure"]),
    ("achtibat24a", "AttnLRP: Attention-Aware Layer-Wise Relevance Propagation for Transformers", 135, 168, ["double_column", "formula", "vector_figure"]),
    ("adcock24a", "A Unified Framework for Learning with Nonlinear Model Classes from Arbitrary Linear Samples", 169, 202, ["double_column", "formula"]),
    ("adepu24a", "FrameQuant: Flexible Low-Bit Quantization for Transformers", 203, 227, ["double_column", "spanning_columns", "vector_figure", "table"]),
    ("adhikary24a", "BeigeMaps: Behavioral Eigenmaps for Reinforcement Learning from Images", 228, 245, ["double_column", "vector_figure"]),
    ("adila24a", "Discovering Bias in Latent Space: An Unsupervised Debiasing Approach", 246, 261, ["double_column", "vector_figure", "table"]),
    ("afshani24a", "Optimal Coresets for Low-Dimensional Geometric Median", 262, 270, ["double_column", "formula"]),
    ("afzal24a", "REST: Efficient and Accelerated EEG Seizure Analysis through Residual State Updates", 271, 290, ["double_column", "vector_figure", "table"]),
    ("agarwal24a", "CHAI: Clustered Head Attention for Efficient LLM Inference", 291, 312, ["double_column", "spanning_columns", "vector_figure", "table"]),
    ("agarwal24b", "Learning to Play Atari in a World of Tokens", 313, 328, ["double_column", "vector_figure", "table"]),
    ("agarwal24c", "Probabilistic Generating Circuits - Demystified", 329, 342, ["double_column", "formula", "vector_figure"]),
    ("agarwal24d", "Improved Differentially Private and Lazy Online Convex Optimization: Lower Regret without Smoothness Requirements", 343, 361, ["double_column", "formula"]),
    ("agarwal24e", "The Non-linear F-Design and Applications to Interactive Learning", 362, 396, ["double_column", "formula"]),
    ("agnihotri24a", "ACPO: A Policy Optimization Algorithm for Average MDPs with Constraints", 397, 415, ["double_column", "formula", "table"]),
    ("agnihotri24b", "CosPGD: an efficient white-box adversarial attack for pixel-wise prediction tasks", 416, 451, ["double_column", "vector_figure", "table"]),
]
HOLDOUT = {"jmlr-19-1030", "jmlr-20-1310", "jmlr-22-0142", "pmlr-acharya24a", "pmlr-adila24a", "pmlr-agarwal24e"}


def main():
    rows = []
    for key, title, pages, tags in JMLR:
        verified_notice = key in {"21-0321", "21-1518", "22-0567"}
        rows.append({"doc_id": "jmlr-" + key, "title": title, "publication_year": 2023,
            "fixed_pdf_url": f"https://raw.githubusercontent.com/JmlrOrg/v24/{JCOMMIT}/{key}/{key}.pdf",
            "publisher_commit": JCOMMIT, "metadata_evidence_url": f"https://www.jmlr.org/papers/v24/{key}.html",
            "license_id": "CC-BY-4.0" if verified_notice else "CC-BY-version-unverified",
            "license_evidence_level": "pdf_notice" if verified_notice else "publisher_policy",
            "license_evidence_url": f"https://www.jmlr.org/papers/volume24/{key}/{key}.pdf" if verified_notice else "https://www.jmlr.org/author-info.html#Publication",
            "license_evidence_quote": "License: CC-BY 4.0" if verified_notice else "authors must sign an agreement granting a CC-by license to the public",
            "expected_page_count": pages, "expected_page_count_source": "publisher_metadata",
            "candidate_tags": tags})
    for key, title, first, last, tags in PMLR:
        rows.append({"doc_id": "pmlr-" + key, "title": title, "publication_year": 2024,
            "fixed_pdf_url": f"https://raw.githubusercontent.com/mlresearch/v235/{PCOMMIT}/assets/{key}/{key}.pdf",
            "publisher_commit": PCOMMIT, "metadata_evidence_url": f"https://proceedings.mlr.press/v235/{key}.html",
            "license_id": "CC-BY-4.0", "license_evidence_level": "publisher_policy",
            "license_evidence_url": "https://proceedings.mlr.press/pmlr-license-agreement.pdf",
            "license_evidence_quote": "paragraph 2: Creative Commons Attribution 4.0 International License",
            "license_policy_link": "https://proceedings.mlr.press/faq.html",
            "publisher_page_range": [first, last], "expected_page_count": last - first + 1,
            "expected_page_count_source": "publisher_metadata", "candidate_tags": tags})
    rows.append({"doc_id": "arxiv-retro-v3", "title": "Improving language models by retrieving from trillions of tokens",
        "publication_year": 2022, "fixed_pdf_url": "https://arxiv.org/pdf/2112.04426v3", "version": "2112.04426v3",
        "metadata_evidence_url": "https://arxiv.org/abs/2112.04426v3", "license_id": "CC-BY-4.0",
        "license_evidence_level": "per_article", "license_evidence_url": "https://arxiv.org/abs/2112.04426v3",
        "license_evidence_quote": "Rights to this article: http://creativecommons.org/licenses/by/4.0/",
        "expected_page_count": None, "expected_page_count_source": "unknown",
        "candidate_tags": ["spanning_columns", "formula", "vector_figure", "table"]})
    for row in rows:
        row.update({"family_id": row["doc_id"], "split": "holdout" if row["doc_id"] in HOLDOUT else "dev",
            "status": "candidate", "layout_verification_status": "unknown", "verified_tags": [],
            "expected_sha256": None, "actual_page_count": None, "synthetic": False,
            "license_checked_on": "2026-11-17", "gold_status": "unannotated"})
        row["attribution_requirement"] = "Retain authors and title from source metadata, license notice, original publication URL; label modifications."
    payload = {"schema_version": 1, "status": "candidate_sources_only", "documents": rows,
        "selection_note": "24 dev / 6 holdout by whole family, selected before gold. Tags are candidates, not verified coverage.",
        "known_gaps": ["natural multi-page tables", "merged cells", "visual layout verification", "80 dev + 20 blind human gold"],
        "counts": {"documents": 30, "dev": 24, "holdout": 6, "publisher_metadata_pages_known": 719,
                   "human_verified_gold_pages": 0}}
    target = Path(__file__).resolve().parents[2] / "docs/quality/candidates.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.exists():
        raise SystemExit("Manifest already exists; inspect it before explicitly changing it.")
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"documents": len(rows), "dev": sum(r["split"] == "dev" for r in rows), "path": str(target)}))


if __name__ == "__main__":
    main()
