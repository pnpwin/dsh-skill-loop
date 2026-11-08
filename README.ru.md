# Skillgrowth для DeepSeek Harness

[GitHub release v0.3.0](<docs/release-v0.3.0.md>): три независимо конфигурируемых режима обучения — **lite** (ReAct-уроки без evaluator'а), **standard** (ACE-lite с paired evaluation) и **heavy** (GEPA-lite эволюция) — детерминированный захват повторяющихся ошибок инструментов как антипаттернов, impact-телеметрия долгосрочной пользы и файловая доставка опубликованных скиллов в `.agents/skills` / `~/.agents/skills` по конвенции [agentskills.io](<https://agentskills.io/specification>). Код/build/CLI/bench scripts — в `src/`; корневые файлы — документация, manifests и DSH discovery metadata. Сопутствующий пакет: [dsh-skillcraft](<https://github.com/pnpwin/dsh-skillcraft>).

[English](<README.md>) · [GitHub](<https://github.com/pnpwin/dsh-skillgrowth>) · [MIT](<LICENSE>) · `@pnpwin/dsh-skillgrowth`

**v0.3.0:** режимы-чекбоксы (default lite+standard) с политикой `escalation`; аддитивная миграция `schemaVersion:3` (ledger error-паттернов, impact-счётчики, `proposal.origin`); повторные ошибки tool'а → уроки-антипаттерны и шаблонные pitfall-вставки (ноль LLM-вызовов); публикация экспортируется в `<gitRoot>/.agents/skills/<name>/SKILL.md` (чужие файлы не перезаписываются, drift детектируется); `/dsh-skillgrowth evolve` — Pareto-эволюция на зарегистрированном trusted paired case set с публикацией только observed-gain победителя; бюджеты расширены (rail 40/день + квоты режимов lite16/standard24, heavy 60 вызовов/run, 1 run/день). [Полные release notes](<docs/release-v0.3.0.md>) · [Конвенции layout скиллов](<docs/skills-layout.md>).

**v0.2.5:** Curator получает компактные правила из ЕДИНОГО DSH skill creator; отдельный native paired evaluator проверяет автоматическую публикацию. Не более одного уточнения по adaptation, без обучения на holdout. Режим, данные и бюджеты сохраняются. [Интеграция, trusted suites и пределы](<docs/curator-evaluator-v0.2.1.md>). Для сравнения нужен подходящий проверенный владельцем набор задач; модельный spec сам не становится полномочием.

**ACE-lite v0.2:** проектное накопление процедурных навыков внутри существующего ReAct-процесса DSH. Видимая работа → ограниченная рефлексия → атомарные уроки → небольшая правка навыка. Это не новый agent loop, сервер памяти, обучение весов или новая UI-панель.

**Историческая проверка v0.2.0:** офлайн unit/integration suite и native smoke с общим лимитом **18 логических вызовов**. Автоматический путь сохранил один урок без skill; отдельный Curator component с явно заданным gold insight создал дельту, прошедшую два native holdout-сценария. Native KV migration/backup/budget/restore прошли пять изолированных проверок. См. [отчёт с измерениями](<docs/validation-v0.2.0.md>). Это проверка интеграции, **не** доказательство роста качества или end-to-end экономии токенов.

## Установка и совместимость

Устанавливайте bundle штатным Plugin Manager DSH; не правьте profile manifests вручную. Установка влияет на все сеансы выбранного профиля. Эта ветка рассчитана на **DSH 0.2.2-rc.1 и Node.js ≥22**. Готовые ESM-модули не требуют сторонних runtime dependencies и install/prepare hooks.

Для проверенного локального checkout попросите агента вызвать Plugin Manager с настоящим абсолютным каталогом:

```json
{"action":"install_bundle","target":"/absolute/path/to/dsh-skillgrowth","enabled":true}
```

Менеджер может оставить ссылку на этот каталог — не удаляйте и не переносите его. Установка tagged release через Plugin Manager:

```json
{"action":"install_bundle","target":"github:pnpwin/dsh-skillgrowth#v0.2.5","enabled":true}
```

После обновления проверьте application result менеджера и живой статус `dsh_skillgrowth`: сохранённый package selection сам по себе не подтверждает активацию.

Перед заменой удалите прежний активный bundle. Публичные row/provider/tool/command переименованы в Skillgrowth; существующую конфигурацию нужно перенести штатным ConfigEditor по [инструкции](<docs/release-v0.2.5.md>). Приватные storage domains `local_skill_loop`/`local_skill_loop_backups` оставлены неизменными: библиотека, pending IDs/hashes, режим и счётчики не теряются. **Предосторожности V2 downgrade остаются в силе.** См. [Хранение и downgrade](<#хранение-и-downgrade>).

## Как работает ACE-lite

1. После обычного пользовательского хода анализируется ограниченная выборка видимых наблюдений: проверенный результат, исправление, антипаттерн или явное вмешательство. Отсутствие сигнала/полезного урока — нормальный no-op.
2. **Reflector** без инструментов извлекает до трёх уроков и узкие insights. Оценки элементов `helpful/harmful/neutral` — гипотезы, не доказательство причинной пользы.
3. Только при наличии insights отдельный **Curator**, тоже без инструментов, возвращает не более одной структурированной delta. Полная выбранная версия или pending preview должна помещаться в input budget; иначе правка удерживается, а не строится по обрезанному тексту.
4. Host-код проверяет источники, ownership, точные base hash/revision, защиту элементов, ёмкость и схему операций. Далее действует политика публикации ниже.

Роль **Generator** остаётся у обычного агента DSH, выполняющего задачу. Вспомогательные learning-роли не запускают shell, не исполняют предложенные regression suites, не меняют права и не пишут напрямую в библиотеку.

### Стабильные элементы вместо постоянной перезаписи документа

У навыка есть описание, trigger и элементы секций `step`, `pitfall`, `check`. У элементов сохраняются ID, версия, защита и evidence refs. Неизменённые элементы сохраняются; уточнение pending привязано к точному preview и активной базе. Имя — примитивная строка до 64 символов: `learned-`, затем непустые ASCII-сегменты `[a-z0-9]` через одиночный дефис; ошибочный ввод отклоняется, а не обрезается/нормализуется.

Грамматика delta намеренно мала:

- `create`: новый навык, до восьми элементов, включая минимум два шага;
- `insert`: новый элемент в указанной позиции секции;
- `replace`: существующий ID и ожидаемый hash элемента;
- `archive`: существующий ID и ожидаемый hash элемента.

Не более четырёх операций на одного управляемого адресата; нет rename, смены scope/permissions и произвольного JSON patch. Новый текст элемента — до 1 200 символов. Модельная delta не может заменить или архивировать защищённый элемент.

Опубликованные `learned-*` — нативные provider-backed skills с фильтрацией по workspace, загружаемые обычным инструментом `skill`, а не файлы, перезаписывающие пользовательскую библиотеку. Загружаемый текст содержит активные элементы, компактный identity manifest и указатель на историю. Полный provenance читается по запросу через `show`/`read`, а не копируется в каждое тело навыка. Это управление размещением контекста, **не измеренная экономия токенов**.

## Review, paired default и legacy soft auto

**Native default v0.2.1:** requirePairedEvaluation=true. Любая auto-публикация, включая добавления, требует подтверждённого exact candidate и независимого выигрыша на adaptation И holdout без регрессий. Нет подходящих trusted project cases → pending, не выдуманные проверки. Таблица ниже описывает review и явно выбранную legacy-политику requirePairedEvaluation=false; это НЕ новый strict default.

**Для нового scope default — `review`; существующий режим сохраняется.** Количество одобрений не переключает режим автоматически. Включение auto не публикует задним числом старую очередь.

| Политика | Правило публикации |
|---|---|
| `review` | Пользователь явно одобряет структурно валидный кандидат с подтверждёнными исходными свидетельствами. Benchmark для этого ручного решения не обязателен. |
| `auto`, ограниченное добавление | Новый подтверждённый навык или не более двух добавлений в хвост секций может публиковаться без evaluator pass. Прежние ограничения и metadata должны сохраниться. Это выбранная **soft-auto политика**, не гарантия качества. |
| `auto`, replace/archive и другие неаддитивные правки | Нужны подтверждённые свидетельства **и** успешная host evaluation точного кандидата в этом scope. Иначе кандидат остаётся pending. |

Аддитивность определяется по **итоговой разнице preview с активным навыком**, а не последней операции. Дописывание к pending с разрушительной правкой не обходит evaluator. Failed evaluation блокирует auto даже для добавлений. Старые V1 proposals не начинают молча публиковаться после миграции.

`evidenceStatus` (`verified`, `unverified`, `contradicted`) отделён от `evaluationStatus` (`not-run`, `passed`, `failed`). `confirmed` означает подтверждение исходных свидетельств, **не** универсальную корректность, пользу или production safety навыка. Human `confirm` не публикует. Ручной `approve` — явное решение пользователя, не evaluator certificate. Ограниченный `sourcePublication` сохраняет точный метод/hash/receipt исходной публикации даже после вытеснения proposal history; pin/rollback не превращают origin evidence в проверку текущей ревизии. Soft judgments привязаны к entry version/hash, считаются только по последним100 сохранённым эпизодам и никогда не разрешают публикацию/pruning.

### Что подтверждает источник

- Короткая однозначная положительная обратная связь настоящего пользователя.
- Распознанный запуск тестов/typecheck с успешным **native outcome** и без противоречащего результата. `job/settled` сопоставляется по owner/session, call ID, label и turn; числовые structured exit metadata — другой поддержанный источник. Текст stdout не может сам удостоверить свой exit status.

«Готово» от ассистента, `isError:false`, успешный read/echo, zero-tests и модельный receipt не подтверждают успех. Отрицательные свидетельства могут снять подтверждение. Эвристики консервативны; неподдержанные/background результаты fail closed. Пользователь может явно подтвердить независимо проверенный результат.

Exposure определяется по durable native событиям загрузки и точному совпадению сохранённого тела/ревизии навыка. Наличие в каталоге не означает загрузку; **loaded ≠ used ≠ helpful**. Неоднозначная или недоступная идентичность остаётся unknown. Private reasoning не используется.

### Evaluator — не универсальный сервис сертификации

Host evaluator принимает только явно зарегистрированные **trusted case-set IDs**. По умолчанию registry пуст. Владелец может задать `declarativeCaseSetsJson` как JSON-массив подходящих case sets для встроенного memory-only runner либо явно подключить доверенный Host runner. Формат конечных операций показан в [native fixtures](<src/bench/native-cases.js>); произвольный JavaScript не исполняется. Зарегистрированные IDs: `/dsh-skillgrowth verifiers`. Прохождение постороннего общего набора не сертифицирует произвольный навык.

Receipt привязан к candidate hash, case-set hash, scope и запуску. Перед прикреплением runtime проверяет принадлежность registry; модельный JSON и копия объекта receipt не являются полномочием. Pass подтверждает только реально выполненные проверки. Плагин не принимает придуманные моделью shell-тесты и не исполняет произвольный сгенерированный JavaScript ради receipt.

[Интерфейсы optimizer](<src/optimizer.js>) дают точки расширения `CandidateProposer` и `CandidateEvaluator`. **Реализации GEPA, GEPA mode/dependency, поиска/рекомбинации или заявления о запуске GEPA нет.** Реализованный способ подготовки кандидатов — ACE-lite; интерфейс не является вторым алгоритмом.

## Команды пользователя и инструмент агента

Это нативные human slash-команды, а не просьба к LLM выполнить shell:

| Команда | Действие |
|---|---|
| `/dsh-skillgrowth status` | Режим, счётчики, очередь и отдельные бюджеты reviews/auxiliary calls |
| `/dsh-skillgrowth pending` | Pending с evidence/evaluation status |
| `/dsh-skillgrowth show ID_OR_NAME` | Содержимое, delta, hashes, история и provenance |
| `/dsh-skillgrowth confirm ID` | Удостоверить проверенный исходный результат; без публикации |
| `/dsh-skillgrowth approve ID`, `/dsh-skillgrowth reject ID` | Явно опубликовать/отклонить |
| `/dsh-skillgrowth mode review`, `/dsh-skillgrowth mode auto` | Явно установить политику scope |
| `/dsh-skillgrowth analyze` | Анализ нового завершённого окна; не обходит подтверждение и лимиты |
| `/dsh-skillgrowth curate` | Advisory/no-op граница; без автоматического semantic merge/pruning |
| `/dsh-skillgrowth pin NAME ENTRY_ID`, `/dsh-skillgrowth unpin NAME ENTRY_ID` | Защитить/снять защиту; новая ревизия инвалидирует stale candidates |
| `/dsh-skillgrowth verify ID CASESET` | Проверить по зарегистрированному host case set; без runner/case set недоступно |
| `/dsh-skillgrowth archive NAME`, `/dsh-skillgrowth restore NAME` | Скрыть/вернуть навык без удаления истории |
| `/dsh-skillgrowth rollback NAME N` | Новая ревизия из сохранённой версии |
| `/dsh-skillgrowth storage-backups` | Список migration snapshots этого scope |
| `/dsh-skillgrowth storage-restore BACKUP_ID` | Явно вернуть валидный V1 project snapshot; см. downgrade |
| `/dsh-skillgrowth pause`, `/dsh-skillgrowth resume` | Приостановить/возобновить learning scope |

Инструмент агента `dsh_skillgrowth` сохраняет только **`status`, `read`, `reflect`**. `reflect` ставит краткое вмешательство на анализ после хода, но не подтверждает успех. Через этот tool агент не может confirm, approve, менять mode, pin, verify или восстанавливать storage. Это граница полномочий API, не sandbox против произвольного кода с доступом к машине.

## Scope и приватность

- Scope — **канонический абсолютный cwd сеанса**, не Git remote и не общий alias репозитория. Подкаталог или worktree — другой scope; автоматического merge между ними и глобальной публикации нет.
- Наблюдения начинаются после активации/перезапуска; после смены cwd старые отсекаются. Унаследованный префикс fork не считается новыми свидетельствами. Native subagents не обучают production library.
- Локальное durable хранение не означает локальный inference. Ограниченные наблюдения, релевантные навыки и уроки отправляются выбранному в сеансе DSH provider/model, если Config не переопределил их.
- Secret redaction — эвристика, **не полноценная DLP/PII-защита**. Не включайте learning для данных, которые нельзя отправлять этому провайдеру. Используйте scope `pause` или plugin `enabled:false`.
- Наблюдения и сохранённые тела — недоверенные данные. Schema/source/framing checks и protection flags снижают риск, но не доказывают семантическую безопасность против любой prompt injection.

## Бюджеты и ограничения

Defaults действуют на канонический scope; суточные счётчики — UTC:

| Ограничение | Default |
|---|---:|
| Вспомогательные model dispatches, **Reflector + Curator + уточнение + evaluator вместе** | **12 всего в сутки**, не по 12 на роль |
| Review cycles (`dailyReviews`, отдельный потолок) | 12/сутки |
| Automatic cooldown | 60 секунд |
| Сумма длин input JSON двух ролей | 16 000 символов |
| Initial output-token cap двух ролей (одно уточнение может повторить Curator allocation) | 3 000: Reflector 1 000 + Curator 2 000 |
| Общий deadline начальных двух ролей | 45 секунд, не по 45 на роль |
| Hard logical cap strict auto cycle | 2 + verificationMaxCalls (default20), включая уточнение |
| Явная verification: бюджет/deadline | 18 logical calls / 120 секунд на запуск |
| Active/all skills; pending/all proposals | 50/100; 50/100 |
| Уроки; записи запусков; ревизии на навык | 200; 100; 10 |
| Активные элементы навыка | 32 |

Полный двухролевой цикл расходует две auxiliary reservations, Reflector no-op может расходовать одну. Резервирование — до dispatch; ошибки/отменённая отправленная работа тоже учитываются. Recursive reviewers и автоматических retry loops нет. Старые суточные attempts сохраняются и консервативно учитываются в новом auxiliary budget; обновление не обнуляет потраченный лимит.

16 000 — **символы суммы payload двух ролей**, не provider tokens и не полный request: system prompts и envelopes добавляют overhead. Поддержанные лимиты и provider/model можно переопределить в Config; температура не навязывается. Экономию контекста и стоимость нужно измерять, а не выводить из cap.

## Хранение и downgrade

Основной native domain `local_skill_loop` сохраняет backend version 1 и прежние таблицы. Прикладные project/control records переходят на `schemaVersion:2`. До первой V2-перезаписи валидных V1 данных store durably сохраняет checksummed snapshot в `local_skill_loop_backups`. ID, режим, история, источники и потраченные бюджеты сохраняются, где применимо; валидный импортированный текст молча не обрезается.

Записи сериализуются по root внутри процесса. Канонический project сохраняется одной native record write; **cross-table transaction** между project, controls и backup не обещается. Некорректные/нечитаемые форматы fail closed, а не молча сбрасываются или downgrade.

Для намеренного возврата на старую версию:

1. Приостановите работу; через `/dsh-skillgrowth storage-backups` выберите валидный V1 **project** snapshot этого scope.
2. Выполните `/dsh-skillgrowth storage-restore BACKUP_ID`. Текущий V2 state архивируется перед восстановлением V1; квота не сбрасывается.
3. Остановите/отключите v0.2 перед установкой старого бинарника. В этом runtime learning восстановленного scope удерживается; повторный запуск v0.2 может снова мигрировать его в V2.

Неизменившийся backend version домена не делает V2 читаемым для старого бинарника. Restore явный; автоматической без потерь двусторонней миграции не обещается. Rollback навыка не отменяет уже совершённые агентом действия в проекте.

Новый пользовательский ввод, отмена, pause/disable или unload отменяют pending work; перед durable записью guard проверяется повторно. Уже начатый/завершённый commit нельзя отозвать задним числом — нужен явный rollback. Unload дожидается собственных jobs и операций store.

## Тесты, сравнения и честные измерения

Из корня пакета:

```sh
node --test --test-reporter=spec tests/*.test.mjs
npm run build
npm run pack:release
```

Актуальный вывод suite — источник результата для этого checkout, а не замороженное число тестов. Офлайн тестируются V2 migration/deltas, net-diff publication gates, stale/protected entries, native evidence, exact exposure, отклонение fake receipts, storage faults, отмена и бюджеты. Fake Host/LLM fixtures не делают платных provider calls. Это проверка механики, не общего качества извлечения или производительности реальной модели.

[Comparison runner](<src/bench/runner.js>) принимает injected bounded native-ReAct `runCase` и независимые immutable snapshots. Сравниваются `no-memory`, `legacy`, `ace`, seeded order, отдельные adaptation/holdout instances и **общий** logical-call cap всех ролей/ветвей. Proposer получает только adaptation observations, не holdout expected checks. Артефакты эксперимента не должны обновлять/публиковать production skills. [Case definitions](<src/bench/cases.js>) — небольшие controlled fixtures, **не общий JavaScript coding benchmark**. Runner сам не исполняет модельные программы и не предоставляет security sandbox.

Общий callback допускает другие явно доверенные case executors. Встроенный native adapter имеет более узкую область: **controlled declarative ReAct environment**, где модель выбирает JSON operations над фиксированными известными примитивами, а не исполняет сгенерированный JavaScript или код через VM. Это workflow-fixture smoke, не JavaScript code-generation benchmark.

[Конкретные adapters](<src/bench/adapters.js>) используют настоящий сохранённый single-role updater v0.1.3 и двухэтапный ACE-lite proposer с одинаковым lexical active-skill selection. `/dsh-skillgrowth benchmark [seed=42] [logical-call-cap=96]` — только явный платный human-command: изолированное сравнение трёх arms, до пяти минут, cap1–200. Production skills и их суточный бюджет не изменяются. Публичные exports `./optimizer` и `./bench` дают extension/test contracts без реализации GEPA.

[Native-отчёт](<docs/validation-v0.2.0.md>) отдельно обозначает автоматический lesson-only результат, Curator component с gold insight от тестировщика и исполнение точного кандидата. Provider usage отделён от синтетического сравнения размера тела. Экономия first-turn provider tokens и общий рост качества skills не заявлены.

Метрики необходимо разделять:

- **Provider-reported** input/output/cache usage; указывать покрытие, отсутствие usage отмечать `unknown`, не выдуманным нулём.
- **Logical dispatches**, включая ошибки/отмены и все роли; это не токены и не гарантированное количество HTTP-запросов.
- **UTF-8 bytes**, JavaScript character counts и tokenizer heuristics — отдельно, с единицей/методом; не складывать с provider-token totals.
- Case outcomes, seed, immutable snapshot/case hashes, порядок, latency, incomplete/budget-exhausted status.

Для заявления об экономии нужен парный замер одной задачи/model/settings с учётом обычного контекста и всего learning/evaluation overhead. Эта документация не устанавливает end-to-end экономию provider tokens или общее улучшение качества. Память может увеличить контекст и ухудшить результат.

## Структура и атрибуция

Весь plugin implementation, build helpers и benchmark code — в [src](<src/index.js>). Существующие [tests](<tests/core.test.mjs>) и [locale](<locale/ru.json>) остаются на месте. В корне — документация, лицензия и package/DSH metadata; release archives сохраняются в игнорируемом `.release/`, не в корне.

- [Host entry](<src/index.js>), [runtime](<src/runtime.js>), [V2 core](<src/ace-core.js>), [legacy compatibility core](<src/core.js>)
- [Наблюдения](<src/projection.js>), [feedback/exposure](<src/feedback.js>), [bounded review](<src/review.js>), [storage](<src/store.js>)
- [Optimizer/evaluator seam](<src/optimizer.js>), [comparison runner](<src/bench/runner.js>), [packaging checks](<src/check-package.js>)

Pinned references и различия лицензий — в [UPSTREAM](<UPSTREAM.md>). ACE-lite — самостоятельная реализация идей ACE, RHI и обратимой skill curation, не официальный upstream port и не воспроизведение их benchmark gains. Иконка оригинальная.
