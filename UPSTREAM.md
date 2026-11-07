# Sources and attribution

This is an independent native DSH implementation. It does not vendor Hermes, ECC, a memory server, or an upstream training framework. No third-party runtime dependencies or install/build hooks are required. The icon is original artwork distributed under this repository's MIT license.

Design references:

- [Recursive Harness Self-Improvement](https://arxiv.org/abs/2607.15524): bounded revision history and feedback-driven refinement. This plugin is RHI-inspired, not a reproduction of the paper's optimizer or evaluation.
- [Hermes skill curator](https://github.com/NousResearch/hermes-agent/blob/6b21d0564de0492e2ebd0d8f63fca86c03b5c892/agent/curator.py): skill lifecycle and recoverable curation.
- [ECC Continuous Learning v2](https://github.com/affaan-m/ECC/blob/d2ef2680594f9a17526a6e1a2e18b3d242c5d17b/skills/continuous-learning-v2/SKILL.md#how-it-works): observations, atomic lessons and project-scoped skill proposals.

The public release preserves the original runtime identities (`local-skill-loop` row/provider and `local_skill_loop` storage domain) so migrating from the earlier local prototype does not rename or delete learned data.
