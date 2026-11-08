# Release v0.3.0 — lite + standard + heavy (GEPA-lite), error-patterns, impact, filesystem delivery

DSH 0.2.2-rc.1+, Node ≥22. Обновление сохраняет хранилище: домены `local_skill_loop`/`local_skill_loop_backups` не изменились, проектные записи мигрируются `schemaVersion 2 → 3` (аддитивно, с чекsummed backup перед первой записью; V1-snapshot restore по-прежнему работает). Счётчики расхода не сбрасываются.

## Learning modes — независимые чекбоксы

| Чекбокс | Default | Что делает |
|---|---|---|
| `learnLite` | ✅ | ReAct-уроки без evaluator'а: no-tools Reflector (1 aux-вызов на цикл), уроки first-class, proposals только при confirmed evidence или из детерминированных error-паттернов. Публикация: human approve, либо soft-auto additive при `liteSoftAuto:true`. |
| `learnStandard` | ✅ | ACE-lite: Reflector + Curator (delta-грамматика), существующая политика review/auto × `requirePairedEvaluation`. |
| `learnHeavy` | ⬜ | GEPA-lite эволюция: только explicit `/dsh-skillgrowth evolve NAME` (или `heavyAuto`). |

`escalation` (`on-insights` default / `on-confirmed` / `never`) управляет переходом lite→standard внутри цикла при включённых обоих. Режимы ортогональны режиму `review/auto`. Любая комбинация чекбоксов валидна; оба выключенных = обучение остановлено (`status` показывает `learning:false`).

## Error-pattern capture (детерминированно, без LLM)

Инструмент, падающий с одной нормализованной сигнатурой ≥ `errorPatternMinRepeats` (default 2) раз за turn и затем успешно отработавший, порождает: урок `kind:antipattern` + templated proposal `insert` в `pitfall`/`check` ближайшего managed-скилла (`origin:'error-pattern'`). Неразрешённые ошибки уроков не дают. Ledger `project.errorPatterns` (cap 50, FIFO) ведёт сквозную статистику сигнатур. Секреты/UNSAFE/FRAMING фильтры те же, что для куратора.

## Долгосрочная польза (impact)

Per-skill счётчики `impact: {loaded, episodes, outcomesVerifiedAfterLoad, outcomesContradictedAfterLoad, errorRecoveries, lastOutcomeSeq}` — корреляция exact-revision exposures с исходами эпизодов. `loaded ≠ used ≠ helpful`: гипотезы, не каузальность; не authority для публикации/прунинга. Поверхность: `status`, `show`, команда `/dsh-skillgrowth impact [NAME]`. Тай-брейкер в pareto-отборе evolve.

## Filesystem delivery (.agents/skills) — default

Опубликованные `learned-*` скиллы экспортируются в файловые бандлы по конвенции [agentskills.io](https://agentskills.io/specification):

- от cwd подъём к ближайшему `.git` → `<gitRoot>/.agents/skills/<name>/SKILL.md`;
- иначе home → `~/.agents/skills/<name>/SKILL.md`;
- иначе → `<cwd>/.agents/skills/<name>/SKILL.md`.

DSH обнаруживает их нативно (источники `project-agents`/`user-agents`). Правила: чужой `SKILL.md` никогда не перезаписывается (`export-conflict`, KV остаётся каноничным, скилл остаётся виден через provider-fallback); drift (ручная правка) детектируется и не затирается молча (`export --force` — только свои файлы); `archive` удаляет наш экспорт; KV каноничен. `skillDelivery: provider` сохраняет старое поведение, `both` — оба канала (с риском дублей в каталоге).

Триггеры экспорта: publish (auto/approve), rollback, pin/unpin, restore, команда `/dsh-skillgrowth export [NAME] [--force]`.

## Heavy: GEPA-lite (`/dsh-skillgrowth evolve NAME [--epochs=2] [--population=3] [--seed=42]`)

Идея GEPA ([arXiv 2507.19457](https://arxiv.org/abs/2507.19457)): reflection-driven эволюция с Pareto-отбором ∝ покрытию. Реализация — нативная, без зависимостей:

1. Требуется ровно один matching trusted paired case set (`appliesTo:{root,names}`); иначе `held-no-trusted-cases`.
2. Baseline оценивается один раз; варианты (`population`, default 3) предлагает Curator с `adaptationFeedback` (только adaptation-фаза; holdout не утекает — anti-leak сохранён). Лимит вызовов фабрики = population + 1 refine-attempt.
3. Каждый вариант стейджится как pending proposal и оценивается `train()` на adaptation split. Pareto-фронт: maximize(gains, coverage), minimize(regressions, deltaSize); `candidateFailed`/`regressions>0`/`incomplete` — вне фронта.
4. Эпохи (default 2): родители с фронта (∝ coverage+1, seedable LCG) + host-side `recombine` (merge непересекающихся правок, ops ≤8).
5. Финал: `finalize()` (holdout) только для победителя → receipt `observed-gain` → публикация через существующий strict gate. `no-gain` честно сохраняет baseline («never a forced rewrite»).

Бюджет: `heavyMaxCallsPerRun` (default 60 логических вызовов) + `heavyMaxRunsPerDay` (default 1). Вызовы внутри run'а не расходуют lite/standard квоты (общий aux-rail учитывается). Никаких публикаций mid-run; abort → ничего не опубликовано.

## Бюджеты (пересмотр)

| Поле | Было | Стало |
|---|---|---|
| `dailyReviews` | 12 (max 100) | **16** (max 200) |
| `maxAuxCallsPerDay` | 12 (max 200) | **40** (max 500) — общий safety-rail |
| `verificationMaxCalls` | 18 | **24** |
| `liteMaxCallsPerDay` | — | **16** (отдельная квота reflector-вызовов) |
| `standardMaxCallsPerDay` | — | **24** (curator + refine + evaluator) |
| `heavyMaxCallsPerRun` / `heavyMaxRunsPerDay` | — | **60** / **1** |
| `heavyMaxInputChars` | — | **24000** (вход куратора в evolve) |

Счётчики (`liteCalls`/`standardCalls`/`heavyRuns`) — UTC-сутки, config-изменение их не сбрасывает. Отклонения: `held-lite-budget` / `held-standard-budget` / `held-heavy-budget`.

## Новые команды и tool actions

- `/dsh-skillgrowth lesson TEXT` и `dsh_skillgrowth(action="lesson")` — немедленный zero-LLM урок (unconfirmed, не публикует).
- `/dsh-skillgrowth impact [NAME]` — impact-счётчики.
- `/dsh-skillgrowth export [NAME] [--force]` — синхронизация экспорта.
- `/dsh-skillgrowth evolve NAME [--epochs=N] [--population=K] [--seed=S]` — heavy run.
- `status` показывает режимы-чекбоксы, квоты по режимам, `schemaVersion`, delivery-режим.

## Данные и миграция

- `schemaVersion:3`: additive `project.errorPatterns`, `skill.impact`, `proposal.origin`. `validateProject` принимает 2 и 3; `migrateProject` цепочка V1→V2→V3; backup V2 пишется перед миграционной записью.
- `renderSkill`/`renderCandidate` манифест `schemaVersion:3`.
- controls: новые счётчики `liteCalls`, `standardCalls`, `heavyRuns` (additive, старые controls валидны).

## Честные ограничения

- Error-pattern тексты — шаблонные; качество ниже кураторских, зато цена ноль LLM-вызовов. Уточнение — через стандартный цикл (Curator) поверх накопленных уроков.
- Impact — корреляция, не каузальность; точные revision-match только.
- GEPA-lite оптимизирует на маленьком trusted case set: перенос за пределы набора не заявлен; заявляется только receipt-bound `observed-gain` на зарегистрированных кейсах.
- Filesystem delivery: DSH-ядро не дедуплицирует слои; `skillDelivery:both` может дать дубли в каталоге — по умолчанию `filesystem`, provider прячет успешно экспортированные скиллы.
- Тесты: `node --test tests/*.test.mjs` — 379 tests, без paid provider calls (fake Host/LLM + native fixtures).
