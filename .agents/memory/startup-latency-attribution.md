---
name: Startup latency attribution
description: Evidence and scope constraints when diagnosing Kinnship foreground startup delays.
---

For foreground-startup investigations, protect working location/tracking behavior.
Do not tune or refactor moving/stationary policy, recovery, heartbeats, acquisition,
publication/consent fences, battery transport, native services or authorization
lifecycles as a startup optimization without separate authorization.

**Why:** The user repeatedly protected the successful unattended location baseline
while authorizing only narrow startup investigation and evidence-supported JS fixes.

**How to apply:** Keep startup candidates observational until a latency stage is
proved. Shared API observation must preserve token storage, notification of token
changes, request order, responses/errors, and existing account/generation guards.

Do not attribute an API promise lifetime to the backend without separating token
access, dispatch, native/transport work, callback delivery and response persistence.
Time-window edge logs are supporting evidence, not request-ID correlation. A
server payload timestamp and phone receipt timestamp require clock-alignment
caveats. Timer delivery lag is not synonymous with JS CPU blocking.

**Why:** Physical A/B exports established a members-to-render dependency but did
not expose which internal API stage consumed the delay. The user explicitly
required these distinctions rather than a speculative server or token-cache fix.

**How to apply:** Report measured intervals separately from hypotheses, bound
diagnostic sampling, and do not claim physical acceptance from simulated timing.
Treat native response completion to JS adapter settlement as a mixed residual,
not pure bridge delivery. Separate native event emission and JS callback entry
before attributing that residual to a specific runtime.

**Why:** The user requires evidence distinguishing response transport,
native processing and native-to-JS delivery, not a renamed unknown interval.
