# Changelog

All notable changes to `@asynx6/nexus-cli`. Versions follow [semver](https://semver.org) loosely; pre-1.0 so minors
break nothing and fixes ship as patches.

## [0.4.2] — 2026-09-27
**Fixes**
- `nexus help` / `-h` / `--help` now all print the help text. Previously bare `nexus help`
  and `-h` fell through the subcommand gate and were treated as a run task, crashing with a
  thrown `NEXUS_GATEWAY_KEY required` error instead of showing help.
- `nexus run` (and the `nexus <task>` shorthand) now wraps `buildRunCtx` in try/catch: a
  missing gateway key prints `run: NEXUS_GATEWAY_KEY required...` and exits 1, never a raw
  stack trace.
- Test `runNexusCli(['help'])` (which already existed and was failing) now passes; the
  "unknown command returns 2" test for a bare word was corrected to match the designed
  shorthand behavior (`nexus <word>` = `nexus run <word>`), not masked.

**Process note (root cause, honest)**
The v0.4.0 `help` crash shipped because the release did not gate on CI. The regression test
existed and **failed on red CI** — see run
[`36257753748`](https://github.com/asynx6/nexus-cli/actions/runs/36257753748) on commit
`1aa449a`. It was not a coverage gap (the test was there) nor a CI-env issue (`ci.yml`
injects no `NEXUS_GATEWAY_KEY`); the release was published despite a failing test. Fixed at
the process level in this release: `release.yml` now runs the full test suite as a hard
prerequisite before the publish step, and `ci.yml` added a `docker:dind` service so the
previously-skipped sandbox integration tests actually execute.

## [0.4.1] — 2026-09-27
- Attempted `help`-fix release. Registry publish failed (E409/E403 on a staged version);
  the fix landed via 0.4.2 instead. This version was never published to the registry.

## [0.4.0] — 2026-09-27
- A→H sprint feature complete: cluster supervisor (A1), memory wired (A2), tool
  auto-discovery (A3), prompt versioning consolidated to `@asynx6/prompts` (A4), webhook
  receiver (D2), per-project encrypted secrets (E1), rate limiting (E3), file
  upload/download (F3), Kubernetes-style `/live` `/ready` probes (G4), opt-in telemetry
  (H2), plugin registry (H3), `nexus ask` (C4).
- **Known bug shipped:** `nexus help` bare-word crash (see 0.4.2). Ships before the process
  fix because the release did not gate on CI.

## [0.3.6] — 2026-09-21
- Consumer packaging fixes: dynamic `import('@asynx6/event-system')` in `events compact`
  now rewritten by the bundler (was `ERR_MODULE_NOT_FOUND` on clean install).

## [0.3.5] — 2026-09-21
- `events compact` EBADF + `--keep-recent` off-by-one fix (PR #63).

## [0.3.4] — 2026-09-21
- Packaging: stage `apps/cli/_publish`, rewrite `@asynx6/*` in both `vendor/` and `src/`
  (was `ERR_MODULE_NOT_FOUND: @asynx6/audit` on clean install).

## [0.3.3] — 2026-09-21
- Consumer bug fixes from crew testing: `init`/`run` crashes, replay 404, false-green
  health checks (PR #62).

## [0.3.2] — 2026-09-20
- `nexus setup` wizard + `.env-gateway` loading fix.

## [0.3.0] — 2026-09-19
- A→H plan landed: license server, snapshot, graceful shutdown, sandbox policy, image
  input, dashboard, DB adapters, GitHub Actions bot, audit chain.