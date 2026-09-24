# GOTV evidence integrity failure

1. Preserve the uploaded object, claimed checksum, independently observed checksum, match manifest, node/lease IDs, and conflict journal. Do not replace the canonical object in place.
2. Confirm the object key matches `matches/<match-id>/gotv.dem` and the uploading node still owned the fenced lease.
3. Re-download the object through the API and independently hash it. Compare byte length and SHA-256 with PostgreSQL metadata.
4. Re-run the pinned demo analyzer. Parser failure, roster mismatch, map mismatch, or checksum mismatch keeps the match disputed.
5. Quarantine the node if multiple artifacts fail or if its claimed checksum differs from the streamed bytes.
6. A moderator may resolve player reports, but must not settle or alter ratings from invalid evidence without an explicit audited reconciliation procedure.
