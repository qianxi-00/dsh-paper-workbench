# Frozen ir-4 primary-model archive

`layout-ir4-primary.json` was produced by the unmodified `runLayout` and archive
at base `310fe96d6579a47e4b63c150ac37e658a0c4420d`, using a synthetic valid two-page
PDF and a fake OCR transport. No base `refillText` was run on this artifact.
It is not an ir-5 model with fields removed. Only `layout.source.path` and
`input.source.path` were anonymized to `fixtures/layout-ir4-primary.pdf`.
All other JSON values, including raw/PDF bytes, model/source evidence and the
original producer/revision receipt, are unchanged. Tests restore the PDF bytes
into their own temporary library and do not follow the stored path.

- Initial revision: `4684c13212c7578dadd53139a8fd502cf92762926e8e451e09e24cc11bbbf88c`.
- Primary model: `PaddleOCR-VL-1.6`, evidence role `service`, batch `1-2`.
- Final JSON bytes SHA-256: `f68116c6844eb38a88d58facb335cdca2222d831fe02df604e596ddb56c74db5`.
- `layout-ir4-primary.sha256` records that digest; `.gitattributes` fixes LF for
  both files so clean Windows checkouts verify the same bytes.
- Runner/CLI/batch assertions are in `scripts/test-layout-legacy-replay.mjs`.

The producer script, independently supplied counterexamples and byte receipts
are retained with the QIAN-69 / PR #10 revision evidence. This fixture verifies
compatibility and data protection, not the quality of a real VL provider.
The historical revision above is the original producer's receipt, not a claim
that its input hash was recomputed after path anonymization. The revision
evidence records the exact two-value transformation from the prior Git blob.
