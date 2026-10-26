# Synthetic snapshot acceptance

This fixture drives the production snapshot-control and offline-inventory commands against two unrelated PostgreSQL 16 containers. It never reads application environment files or a persistent database.

1. Start a uniquely named synthetic source container and volume with PostgreSQL 16.
2. Apply the repository's existing migrations only to that empty source and run `fixture.sql`.
3. Run `prepare.ts` to produce a custom-format archive, source observations, a random approval key, and a reader credential for a separately generated run ID.
4. Approve the archive with `npm run lifecycle:snapshot-control -- approve ...`.
5. Start `docker-compose.snapshot-inventory.yml` with the generated run ID, database, loopback port, and volume name.
6. Run `npm run lifecycle:snapshot-control -- restore ...`; this is the only supported receipt creator.
7. Run `npm run lifecycle:evidence-inventory:offline -- ...` and compare its seven identities and counts with `verify.sql`.
8. Run `mutate-after-receipt.sql` on the target and verify a second inventory fails its table-digest check without creating output.
9. Run signed-receipt cleanup, then remove only the explicitly named synthetic source container and volume. Verify all four identifiers are absent.

The unit safety suite covers false archives, wrong PostgreSQL major version, forged/missing/stale/mismatched receipts, copied-instance receipts, post-receipt changes, output races, canonical repository containment, and symlink/junction rejection. The integration procedure additionally verifies custom archive inspection, wrong archive checksums, loopback-only ingress, denied target egress, fresh resources, dedicated read-only credentials, unchanged source/target position digests, and exact cleanup.

On Windows, create the acceptance root outside the repository and cloud-synchronized directories, remove inherited ACLs, and grant only the current operator full control before writing keys, credentials, approvals, receipts, or reports. The commands refuse execution if those ACL properties cannot be verified.
