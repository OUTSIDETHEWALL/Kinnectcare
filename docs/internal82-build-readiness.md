# Combined internal-testing candidate: Build 82

Prepared for owner review on 2026-11-22. This document is not build or release
authorization.

## Source and scope

- Authoritative main: `bf562917842206303b3444b1382a80094bf8e46e`.
- Billing PR #207: `04ebca0622f837e49dd60513775dfe6a3d7b123e`.
- SOS inbox PR #208: `cec7afa3c22561f52f586ebae2804d6821d99f00`.
- Conflict-free combination tree before build metadata:
  `0c22b5ea39a588c16a09bec85a522d2385cb025c`.
- The candidate is a single-parent review snapshot on top of the billing head,
  containing the exact SOS patch plus this report and one new EAS profile.
  No PR or branch was merged. Main and both original PR branches are unchanged.
- The final candidate commit is recorded in its review PR, avoiding a
  self-referential commit identifier in this file.

No application implementation was changed beyond the two reviewed PR patches.
No backend, production setting, signing credential, channel mapping, OTA or
build was changed or created remotely.

## Proposed Android identity

| Field | Proposed value |
| --- | --- |
| EAS profile | `billing-sos82` |
| Package | `app.kinnship.client` |
| Display version | `1.3.1` |
| Android versionCode | `82` |
| Android runtime | `1.3.1-diagnostic82` |
| Update channel | `internal-billing-sos82` |
| Distribution / format | `store` / Android App Bundle |
| Version source | Local; auto-increment disabled |
| Eventual distribution | Owner's manual Google Play internal-track upload |

Read-only EAS checks found the latest Android build was 81 and no Build 82
record existed. Play Console's highest uploaded code was not independently
verified; confirm 82 remains available immediately before build authorization.
The proposed update channel does not exist yet and was not created.
It must not be mapped to the production update branch.

The profile inherits existing production native-build configuration/credential
context, not production update delivery. The existing production and all other
profiles, submit configuration, and app-version source are unchanged. Profile
resolution was asserted locally, including Android's runtime override.
The new runtime cannot receive Build 81 updates even if a channel is misrouted.
No signing continuity or delivered native dependency claim is made until the
separately authorized AAB is built and inspected.

## Transfer failures: root cause and risk

The following unchanged tests still fail:

- `test_resolution_change_during_transfer_retries_and_blocks`
- `test_concurrent_dependent_insert_after_snapshot_must_block`

Both mutate MongoDB directly, bypassing the cooperative family-write fence.
Mongo snapshot transactions do not predicate-lock these unfenced external
writes. Therefore the tests' expected 409 is not guaranteed against arbitrary
raw database writers. They also fail on the exact unchanged main above.

The family fence, SOS history, email-link transfer, family-group and SOS priority
modules, plus the application-fence test module, are byte-identical across main
and both PR heads. The two failing test bodies and the relevant server SOS,
resolution, member-creation, alert-list, acknowledgment and Clear All handlers
are executable-AST-identical.

The expanded combined run was **148 passed, 2 failed, zero skipped**. All 32
application-fence cases passed, including both writer orderings for dependent
creation, SOS reopening/new SOS, care records, rollback, reauthorization,
uncertain commits and retained-history access.

Assessment: high confidence these are not regressions from either PR. The
owner previously accepted cooperative application-writer protection, not a
database invariant against arbitrary direct writes. They do not add a blocker
to this isolated internal candidate within that boundary. They remain real
maintenance-path limitations: do not run unfenced structural database edits
concurrently with transfers. Keep these failures visible; no assertions were
weakened, removed or marked expected-failure.

## SOS, history and Stripe preservation

- The previously verified 204 frontend cases remain applicable: application/test
  source is identical to the tested combined tree. Only this report and the
  new EAS profile differ.
- Active, acknowledged-but-unresolved, unknown-resolution and reopened SOS stay
  visible; Clear All only locally dismisses explicitly resolved SOS.
- Raw history remains separate from per-account/family/device dismissal marks.
  Existing 30-day resolved retention remains unchanged; active SOS is not
  made TTL-eligible.
- The new expanded backend run includes actual Clear All, history and retention
  tests, Stripe webhook reconciliation, Google/Stripe coexistence, provider-aware
  management and no entitlement rewrite on provider failure.
- Existing Stripe grants remain independently authoritative. Google access
  denial or reconciliation switches cannot revoke an active Stripe grant.
  No Stripe migration, cancellation, live billing operation or customer-data
  mutation was performed.
- The new profile explicitly sets both public Google integration/purchase flags
  to false. Existing Stripe checkout remains selected; no Google recovery or
  purchase is activated by installing this candidate.

## Readiness and remaining gates

**Source-ready for separately authorized native-integration/SOS validation;
not a Google purchase-acceptance candidate or a production release.**

The binary would include the billing native dependency source and the SOS fix,
but Google purchase/recovery behavior is deliberately disabled. Do not describe
an off-gated native build as proof of functional Play Billing.

Before a billing-enabled build is useful, separately approve and verify the
Google/RevenueCat app, catalog/product identifiers, public SDK key, original-owner
restore setting, sandbox/test-family scope and backend verification/webhook
readiness. Existing workspace integration does not establish serving-backend
configuration. Switching either client flag requires a new reviewed candidate
commit; never activate it through an unreviewed build-time override.

After separate build approval: verify existing upload-signing continuity and
the delivered billing permission/classes/version; provide the AAB for manual
owner upload only. Physical two-phone SOS visibility/history/clear/restart/reopen
acceptance, data-preserving Play upgrade, Stripe regression checks, and eventual
license-tester payment lifecycle acceptance remain unperformed.

Full TypeScript verification retains the known unrelated
`schedulingTracing.test.ts:68` TS2345; no new application diagnostics were found
in the prior identical-source check. Jest still uses its existing force-exit
workaround. No native compile or installed-phone acceptance is claimed.

Stop for owner approval. Do not merge, build, upload, deploy, publish an OTA,
create/map a channel, or change live configuration from this readiness report.
