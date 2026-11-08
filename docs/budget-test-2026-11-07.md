# Live budget test — 2026-11-07

Installed version: v0.2.0, native `ace-lite`, existing project in review mode. This newly user-authorized test is separate from the earlier capped 18-call smoke; that historical ledger was not changed.

## Procedure

1. Inspect the existing native Config schema: budget fields are configurable, not hard-coded policy constants.
2. Save only the original two budget fields and preserve all other settings. Original `dailyReviews` was explicitly 12; `maxAuxCallsPerDay` was absent and resolved to default12.
3. Through native ConfigEditor, temporarily set `dailyReviews=13`, `maxAuxCallsPerDay=14`; preserve used counters12/12. Use a five-minute restoration guard.
4. Run the actual offline suite: 295 tests passed, 23-module package check passed. Queue a reflection hint without human confirmation. Let the normal production turn-end listener start learning.
5. Inspect actual native status/telemetry; restore the precise original fields through ConfigEditor and remove the disposable helper through Plugin Manager.

## Observed production result

- Completed at 2026-11-07T20:57:36.549Z (23:57:36 MSK).
- Run: `e62aabe547f9cd95f21e3098e92b9379`.
- Status: `noop-empty`, no error code.
- Reflector: one actual logical call, latency3888ms.
- Provider-reported usage: input1688/output73/total1761tokens; cache usage not reported. This is not an HTTP-retry or billing-total assertion.
- Payload5508characters, serialized input5806characters, system1507characters, visible output43characters. These counters are not token estimates.
- No useful new insights were retained; Curator correctly skipped. This run therefore validates the automatic trigger, Reflector, empty-result policy, telemetry and budgets, **not fresh skill creation, Curator execution, or a quality improvement**.
- Learning runs12→13; cycles/calls spent12→13. Lessons10, pending8, active skills0 unchanged. No source confirmation, candidate verification, publication or mode command was executed.

## Restoration

- Restored at 2026-11-07T20:57:51.258Z via the explicitly authorized restoration tool.
- Exact original field presence restored: dailyReviews12; maxAuxCallsPerDay absent, effective12.
- Live status confirms effective caps12/12 with spent counters13/13. This deliberate over-cap state is truthful spending, not a reset or corruption; normal day rollover is UTC.
- Mode remains review, pausedfalse; pending proposal IDs/hashes unchanged.
- Helper bundle removed, application applied; native Config directory has zero entries for it.

## Setup corrections

The disposable helper first failed before configuration edits: native tools require both output.schema and output.render. A second setup attempt rejected ConfigEditor.edit inside activation with `HMR transactions cannot be nested`; it also changed no budget. The corrected helper has an explicit post-activation begin action and a bounded restoration-only action. Offline tests covered no edits during activation, native output rendering, raising only two fields and exact restoration. No test helper is part of the published plugin.
