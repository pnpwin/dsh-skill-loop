# GitHub release v0.2.4

The paired-evaluator integration and strict auto gates are preserved. This release publishes the tested source, refreshes the versioned native ESM generation and aligns creator naming with dsh-skill-creator0.1.2. Runtime status/telemetry now use creator naming; old persisted historical telemetry is not rewritten. No application/backend storage schema migration or permission expansion is introduced.

Code/build/CLI/bench sources live in src/. Only metadata, README/LICENSE/UPSTREAM and DSH discovery manifests remain as root files. Existing tests/ and locale/ directories are unchanged. The source-generation checksum/distribution/root-file checks remain mandatory. Obsolete generated copies and private planning/log files are not published.

Install the pinned GitHub source with Plugin Manager:

```json
{"action":"install_bundle","target":"github:pnpwin/dsh-skill-loop#v0.2.4","enabled":true}
```

Install/upgrade affects the whole profile; inspect application and live skill_loop status, not just the saved package selection. Existing mode, paused state, pending proposals, evidence and daily counters must survive. No old queue is automatically approved or published. UTC quota rollover is unchanged.

The companion skill is https://github.com/pnpwin/dsh-skill-creator. No new paid evaluator runs or skill-quality gains are claimed by this release. Historical validation reports retain their own versions and limitations; a relevant owner-reviewed project suite is still required for strict automatic publication.
