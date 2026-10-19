# Palazzo review contract

Palazzo is a single-program internet-radio playout appliance: one container
combines a private NestJS/Fastify control API, Liquidsoap and Icecast. Alcantara
uses it to prepare immutable filler, play songs with optional recorded intros,
mix instants and live audio, observe authoritative playback, and maintain a
continuous listener stream.

Preserve program isolation, private control/telemetry interfaces, durable
idempotency before audible effects, bounded dependency retries and metric labels,
explicit Start/Stop reconciliation, actual media validation, and an uninterrupted
Icecast mount. Command acceptance is not proof of playback; engine observations
and real output bytes establish that result. Startup never invents a prior
operator Start or Stop.

Assess purpose and evidence rather than the number of changed files or lines.
Bug fixes, meaningful tests that raise coverage, dependency repairs, and
operational maintenance can serve this existing appliance without a new product
decision. Browser access to existing private controls, protocol correctness,
recovery, media validation and accurate telemetry are established obligations.
New capabilities must have repository documentation or linked acceptance criteria
that establish their actual need and boundaries.

Ask gaulatti for a second opinion for a product-direction or authority decision:
for example turning the appliance into a content-generation platform, a general
CMS, a multi-tenant hosting service, or a publicly exposed control system.
Ordinary implementation uncertainty and repairable bugs belong to automated
investigation, not routine human code review. Changes to review controls,
coverage exclusions, or this purpose contract require explicit owner confirmation.

Every material capability and mechanism must independently score at least 80 for
fit, need and proportionality under Clouseau's shared protocol. A causal technical
finding at or above 70 blocks; unrelated features or good scores cannot average
away a defect. Integrity and review-completeness gates remain independent.

Tests must assert actual production behavior and failure outcomes. Reject
fabricated coverage, disabled tests, swallowed errors, unconditional assertions,
test-only readiness paths and mocks that replace the behavior being claimed.
External socket, subprocess and filesystem fault injection is legitimate when
the real application contract and failure handling remain exercised. The pinned
container must separately prove real ffmpeg preparation, Liquidsoap control,
Icecast output bytes, lifecycle reconciliation and parsed bounded metrics.

All tests and exactly 100% application line and branch coverage remain mandatory
for every contribution, including external forks. Unloaded bootstrap and module
files must be measured. Missing or unresolved integrity evidence holds approval;
intent confirmation cannot waive it. Contributor code never receives provider,
repair or approval credentials, and fork PRs cannot trigger automatic repairs.

Clouseau owns the shared scoring, investigation, repair bounds, evidence ledger,
native approval and auto-merge. This repository owns its purpose, real tests and
runtime evidence. CI/merge, deployment completion and live health are separate
milestones; a successful merge alone is not a deployment or playback claim.
