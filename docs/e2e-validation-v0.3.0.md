# E2E Validation Report — dsh-skillgrowth v0.3.0

Дата: 2026-11-09. Метод: standalone-харнесс с реальными LLM-вызовами (DeepSeek API, deepseek-chat) + headless-профиль DSH.

## Резюме

| Компонент | Статус | Метод |
|---|---|---|
| Установка в профиль desktop | ✅ | Plugin Manager, bundle v0.3.0, link:/local/repo |
| Конфиг бандла (режимы, бюджеты 50/50) | ✅ | `--dump-config` показывает все поля v0.3.0 |
| Загрузка в headless-профиль | ✅ | `dsh --profile headless --dump-config` |
| Реальный LLM-рефлектор | ✅ | E2E-харнесс: 2107ms, валидный JSON с уроками |
| Реальный LLM-куратор | ✅ | E2E-харнесс: 2909ms, create-дельта с 5 entries |
| Schema v3 в реальном storage | ✅ | `schemaVersion: 3` в project record |
| Error-pattern capture | ✅ | 2×ENOENT + recovery → antipattern lesson + ledger |
| Lesson command (zero-LLM) | ✅ | `lessons-only` status, немедленная запись |
| Approve → publish | ✅ | `pending-review` → approve → skill rev=1 |
| FS export (.agents/skills) | ✅ | SKILL.md + .skillgrowth.json sidecar созданы |
| Provider скрывает экспортированные | ✅ | list/status не показывает exported skill |
| Budget tracking (lite/standard) | ✅ | attempts=1, auxCalls=2, separate counters |
| A/B proposer: ACE arm | ✅ | Реальный reflector+curator, валидный candidate |
| A/B proposer: legacy arm | ✅ | Ожидаемый fail (no anchor citations — by design) |
| Полный test suite | ✅ | 379/379 tests green |

## Детали E2E-харнесса

Харнесс: `/tmp/e2e-harness.mjs` (standalone, mock ctx + real LLM proxy → DeepSeek API).
- Workspace: tmpdir с `.git` (проверка git-root export path)
- Сценарий 1: turn с recognized test command (`node --test`) + human success («Теперь работает») → reflector извлёк урок, curator создал proposal `learned-verify-new-function-with-test` (confirmed=true, status=pending)
- Сценарий 2: 2× ENOENT от read + recovery → antipattern lesson + `errorPatterns` ledger запись
- Approve: детерминированный stage + `approve` command → publish → fs export
- Export: `.agents/skills/learned-e2e-verify-behavior/SKILL.md` + `.skillgrowth.json` (scopeHash, revision, candidateHash)
- Provider: `list` не возвращает exported skill (filesystem delivery активна)

Реальные LLM-метрики (typical):
- reflector: ~550-760 chars output, 1.3-2.2s latency
- curator: ~1300-1970 chars output, 2.6-3.6s latency
- total cycle: 2 aux calls, ~5s

## Детали A/B proposer test

Харнесс: `/tmp/e2e-bench-propose.mjs` (bench adapters + real LLM, fake runCase).
- Фикстура: `order-adapt` (correction-and-check family) из `createNativeFixtureSet()`
- Observation: passed=true с confirmationSeqs=[4]

**ACE arm (v0.3.0)**: reflector (607 chars) → curator (1855 chars) → валидный candidate `learned-preserve-first-occurrence-fixture-order` rev=1, 5 entries. Budget: 2/10 calls. Tokens: 1419 in / 541 out / 512 cache.

**Legacy arm (v0.1.3 baseline)**: LLM вызван (1720 chars), но draft отклонён `benchmark-invalid-draft` — отсутствует обязательное anchor-цитирование (`citesAnchors` check). Это by design: legacy = старый менее строгий baseline, ACE = улучшенная валидация.

## Ограничения

- Полный трёхрукийй A/B benchmark (no-memory/legacy/ace с реальными агентами) требует полного DSH agentLoop (NativeToolExecutor внутри asar) — не воспроизводится standalone. Proposer-path обеих рук протестирован с реальным LLM.
- Desktop profile (основной) имеет v0.3.0 установленный, но текущая GUI-сессия работает со старым fiber. Новые сессии получат v0.3.0.
- Headless e2e (`dsh headless "task"`) — плагин инициализируется и создаёт backup, но async learning cycle не успевает завершиться до выхода процесса. Это ожидаемо для one-shot headless.


## Полный реальный A/B benchmark (обновление 2026-11-09)

Выполнен НАСТОЯЩИЙ трёхрукийй benchmark через нативный dispatch команды в headless-профиле DSH
(patch-плагин `/tmp/e2e-bench-trigger` вызывает `commands.execute(agent, '/dsh-skillgrowth benchmark 42 96', [], signal)`
с изолированным id агента; агент основной задачи поллит маркер-файл, удерживая процесс).

**Результат** (полный отчёт: [benchmark-real-2026-11-09.json](benchmark-real-2026-11-09.json)):

- status: completed, 194.2s, 61/96 logical calls
- **18/18 кейсов PASS** (3 adaptation + 3 holdout × 3 руки: no-memory / legacy / ace)
- Токены: no-memory 4720in/1038out, legacy 4407in/3233out, ace 3900in/1126out (cache ~15-16k у всех)
- legacy: 1 proposal, 2 proposal errors; ace: 0 proposals, 3 proposal errors
- Production storage не тронут (experiment-only in-memory snapshots — подтверждено)

Интерпретация: фикстуры `native-declarative-workflow-v1` проходятся deepseek-chat без памяти
на всех руках — сигнала для обучения нет (ошибок нет), proposals в основном отклоняются
валидацией draft'ов на синтетическом feedback. Это честный результат smoke-уровня,
не качественный бенчмарк (как и заявлено в методологии плагина).

### Как воспроизвести

```bash
export DEEPSEEK_API_KEY=...  # или через credentials DSH
rm -f /tmp/e2e-bench-done /tmp/e2e-bench-result.json
dsh --profile headless --patch /tmp/e2e-bench-patch.yml   "Run: while [ ! -f /tmp/e2e-bench-done ]; do sleep 15; done; echo BENCHMARK FINISHED"
```

Требуются: `/tmp/e2e-bench-trigger/index.js` (package.json + index.js, см. /tmp) и
`/tmp/e2e-bench-patch.yml` (insert file:// plugin).
