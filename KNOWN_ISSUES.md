# Known limitations & deliberate trade-offs

Frozen at v0.4.2 (A-H sprint complete). Items below are **conscious decisions**,
not forgotten bugs. Each notes the trade-off and when to revisit.

## Behavior — deferred, not bugs
| # | Area | Limitation | Why deferred | Revisit when |
|---|------|-----------|--------------|--------------|
| 1 | `agent-runtime/src/loop.js` | Verdict detection uses a regex `/\b(PASS|FAIL|FAILED|ERROR)\b/i` over the model's text content to short-circuit as a final answer, instead of an explicit signal (e.g. a separate `final: true` field from the model). | The regex is a stable workaround for the hermes-agent provider's behavior (forced via the P09 e2e gate). An explicit `final` field is a provider-contract change — out of scope for a frozen release. A model replying with the word "ERROR" in prose could be misread as a verdict. | First provider that returns a structured verdict field; or when consensus mode (which already produces richer results) becomes the primary path. |
| 2 | `packages/model-providers/src/provider.js` | Only the **first** `tool_calls` element is honored per turn; parallel tool calls from the model are silently dropped (`msg.tool_calls[0]`). | "Native function calling" framing assumes one call per turn. Supporting the full array is a behavioral addition, not a fix — conflicts with "no new features during freeze". | A real workload (or runner) that sends multiple parallel tool calls. Low urgency — most OpenAI-compatible gateways issue one call per turn. |
| 3 | `apps/api/src/auth.js` | The expected token is captured once when the middleware is constructed; rotating the token at runtime requires a process restart. | Stateless capture is simpler and avoids a per-request config lookup. Runtime rotation is an edge case, not a security hole (old token simply keeps working until restart). | When credential rotation needs to be zero-downtime. |

## Process findings — historical, for accuracy in release notes
- The `nexus help` crash in v0.4.0 was caught by v0.4.1/v0.4.2. Diagnosis correction:
  the regression test `runNexusCli(['help'])` **already existed** in `cli.test.js` and
  **failed on the pre-fix commit** — CI was red (run 36257753748 on `1aa449a`), not
  green. The ship happened despite red CI. Root cause is release process (ship did
  not gate on CI), not test coverage and not CI env missing a key (`ci.yml` injects
  no `NEXUS_GATEWAY_KEY`, and the failure reproduced without one anyway).

## Scope note
- 14 packages at v0.2–v0.3 while core (agent-loop, permission gate) had moderate
  coverage is a recognized expansion risk. The core paths (agent-runtime,
  sandbox-runtime, security) are exercised by the e2e gate + unit suites on CI;
  consensus/multi-agent/license-server are additive and frozen as-is. Re-baselining
  core coverage before new features is a roadmap decision, tracked by the maintainer.