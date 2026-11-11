# Backend safety corrections for email-link onboarding

## Scope and evidence

Companion changes to the unmerged email-link onboarding work. No client API,
Android source, application version, runtime, dependencies, credentials or
deployment settings change. The verified Build 79 bundle remains unchanged.

- **Critical, high confidence:** the previous family-transfer guard counted only
  login accounts. An owner with a dependent could transfer, delete the old
  family and leave that dependent's medication records behind.
- **High, high confidence:** retained OTP failure helpers logged raw login codes.
  Provider response/exception text could also echo authentication message content.

## Corrections

Before an owner moves families, check for other member rows and care records
that will not move with their own self-member. Return HTTP 409 before any
mutation if such records exist. Keep the existing other-account ownership guard.
After a successful move, delete an old family only if it has neither accounts
nor records in any of the family data collections.

Non-owner transfers retain their existing behavior: move only the caller's own
records, clear prior sharing/location authority, and leave other people's data
in the original family. Empty and self-only owner transfers still succeed.

Redact OTP values from all delivery failure paths in both deployable server
entrypoints. Do not log provider response bodies or arbitrary exception text;
retain HTTP status, exception type and safe delivery context. Keep actual email
content, transport order, return values and authentication endpoints unchanged.

## Verification

```
python -m pytest -q \
  backend/tests/test_email_links.py \
  backend/tests/test_otp_log_redaction.py \
  backend/tests/test_family_member_removal.py \
  backend/tests/test_family_roles_reminder_permissions.py
```

Result: **69 passed**. Family endpoint tests cover rejection without stored
mutation, dependents without accounts, every family care collection, preservation
of non-owner behavior and successful empty/self-only transfers. Delivery tests
execute real helper functions from each server entrypoint with mocked network
transports, including provider echoes of message content, and verify that
successful emails still contain their code.

An additional legacy integration suite required an unavailable MongoDB server
and timed out; it is not included in the passing result. No live MongoDB
write/commit, real mailbox delivery or physical Android acceptance is claimed.
Transaction endpoint tests use an isolated fake, not Atlas conflict validation.

## Risk and release boundaries

The new guard intentionally refuses an owner's transfer when their family still
needs an owner, including malformed/unlinked care records that cannot safely be
moved. Such records require reviewed ownership/data cleanup, not automatic
deletion. Error logs deliberately omit provider payload text; use response status
and exception class when diagnosing delivery failures.

Nothing merges or deploys without owner approval. This companion PR targets the
onboarding branch, not production `main`. Production activation still requires
the verified Play app-signing fingerprint and link-origin configuration, email
expiry indexes, approved transaction-write/email smoke tests, and retained Build
78 authentication checks. Upload to Google Play internal testing is separately
approved; domain verification and real email-tap behavior require that
Play-installed build.
