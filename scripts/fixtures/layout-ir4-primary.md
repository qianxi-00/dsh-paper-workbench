# Frozen ir-4 primary-model archive

`layout-ir4-primary.json` was produced by the unmodified `runLayout` and archive
at base `310fe96d6579a47e4b63c150ac37e658a0c4420d`, using a synthetic valid two-page
PDF and a fake OCR transport. No base `refillText` was run on this artifact.
It is not an ir-5 model with fields removed. Its `source.path` is a historical
synthetic producer path; tests restore the PDF bytes into their own temporary
library and do not follow that path.

- Initial revision: `4684c13212c7578dadd53139a8fd502cf92762926e8e451e09e24cc11bbbf88c`.
- Primary model: `PaddleOCR-VL-1.6`, evidence role `service`, batch `1-2`.
- JSON SHA-256: `aee18e2a15736ce5471042ac0c93afb186de47609be5774a9f73be0f7c1df708`.
- Runner/CLI/batch assertions are in `scripts/test-layout-legacy-replay.mjs`.

The producer script, independently supplied counterexamples and byte receipts
are retained with the QIAN-69 / PR #10 revision evidence. This fixture verifies
compatibility and data protection, not the quality of a real VL provider.
