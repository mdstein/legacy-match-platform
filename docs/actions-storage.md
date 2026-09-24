# GitHub Actions artifact retention

Routine CI artifacts expire after seven days. This covers Playwright failure
evidence, rollback test evidence, unsigned launcher candidates and host bundle
candidates. The signed-release workflow retains its separate 30-day policy.
Published website downloads and GitHub Release assets are separate from these
routine CI artifacts.

On September 8, 2026, the production repository had 258 Actions artifacts totaling
3,126.49 MiB. Seventeen `playwright-evidence` archives from August 30–September 5
accounted for 2,948.19 MiB; the other 241 artifacts totaled 178.30 MiB. These
artifacts inherited 90-day expiration dates. The new seven-day workflow setting
applies to future uploads and does not remove this existing backlog.

The launcher 0.2.40 commit used `[skip ci]`; the runs API confirmed zero runs for
its SHA. Actions remained disabled in the isolated Classic repository. The
retention-only commit also skips CI; its parsed workflow was compared with the
previous version to verify that only four retention values changed.

The local cleanup inventory is `.artifacts/actions-storage-20260908/audit.json`.
The backup helper in that directory downloads only the 17 identified Playwright
archives, verifies each ZIP against GitHub's SHA-256 digest, and records completed
backups in `backup-receipt.json`. It performs no deletions. Cloud removal requires
separate approval after all backups are verified.

GitHub bills storage by hourly accrual. Removing artifacts reduces current
storage and future accrual, but does not erase usage already accrued in the
current billing cycle. The dashboard can take 6–12 hours to reflect updates.
See [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions).
