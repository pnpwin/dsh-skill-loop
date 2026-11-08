# Настройка бюджетов обучения

Бюджеты — поля нативной Config-схемы плагина `@pnpwin/dsh-skillgrowth` (entry `dsh-skillgrowth`). Это не константы: изменяйте штатным редактором DSH (native ConfigEditor); не редактируйте вручную package/patch-файлы профиля. Изменение лимита применяется через lifecycle Loader и может перезапустить runtime плагина; **счётчики расхода не сбрасываются**.

## Режимы (чекбоксы)

| Поле | По умолчанию | Назначение |
|---|---|---|
| `learnLite` | true | ReAct-уроки без evaluator'а (Reflector-only цикл) |
| `learnStandard` | true | ACE-lite (Reflector + Curator + paired evaluation по политике) |
| `learnHeavy` | false | GEPA-lite эволюция (только explicit `/evolve` или `heavyAuto`) |
| `escalation` | on-insights | Переход lite→standard: on-insights / on-confirmed / never |
| `liteSoftAuto` | false | Soft-auto additive-публикация error-pattern вставок в auto без evaluator'а |

## Лимиты

| Поле | По умолчанию | Допустимо | Назначение |
|---|---:|---:|---|
| `dailyReviews` | 16 | 1–200 | Максимум циклов в сутки для проекта |
| `maxAuxCallsPerDay` | 40 | 1–500 | Общий safety-rail: все модельные вызовы всех ролей, включая неуспешные |
| `liteMaxCallsPerDay` | 16 | 1–100 | Квота reflector-вызовов (lite) |
| `standardMaxCallsPerDay` | 24 | 1–200 | Квота curator + refinement + evaluator вызовов |
| `heavyMaxCallsPerRun` | 60 | 10–200 | Логических вызовов на один `/evolve` run |
| `heavyMaxRunsPerDay` | 1 | 1–5 | Запусков `/evolve` в сутки |
| `heavyEpochs` | 2 | 1–3 | Эпохи эволюции |
| `heavyPopulation` | 3 | 2–4 | Вариантов на поколение |
| `maxInputChars` | 16000 | 4000–24000 | Суммарный JSON payload двух ролей обычного цикла; не число токенов |
| `heavyMaxInputChars` | 24000 | 8000–48000 | Вход куратора в heavy-режиме (adaptation feedback traces) |
| `maxOutputTokens` | 3000 | 1000–6000 | Общий output-бюджет: 1/3 Reflector, 2/3 Curator |
| `timeoutMs` | 45000 | 5000–120000 | Общий deadline одного цикла |
| `cooldownMs` | 60000 | 0–3600000 | Минимальный интервал между циклами |
| `verificationMaxCalls` | 24 | 1–100 | Лимит явной проверки кандидата |
| `verificationTimeoutMs` | 120000 | 5000–300000 | Deadline явной проверки кандидата |
| `errorPatternMinRepeats` | 2 | 2–5 | Повторов ошибки до фиксации антипаттерна |

Один lite-цикл — один вызов; эскалация в standard добавляет curator-вызов. Вызовы внутри heavy-run учитываются в общем rail `maxAuxCallsPerDay`, но не расходуют lite/standard квоты. Отклонения резервирования: `daily-budget`, `auxiliary-budget`, `lite-budget`, `standard-budget`, `heavy-budget`, `cooldown` (телеметрия показывает `held-*` формы).

Настройки относятся к профилю; счётчики расхода хранятся отдельно для каждой канонической рабочей директории. Суточный период — UTC (для Москвы сброс в 03:00 МСК). Для запуска нужен новый подходящий завершённый эпизод; смена суток сама по себе фоновую задачу не запускает.

Бюджет не меняет полномочия: режим review остаётся review; подтверждение результата, проверка кандидата и разрешение публикации независимы. Нулевое число активных навыков означает, что pending-предложения ещё не применяются.

## Временный тест

Измените лимиты через ConfigEditor, проверьте `status` (раздел `budget`), после теста восстановите прежние значения. Расход не откатывайте: использованные вызовы остаются израсходованными до следующего UTC-дня. Нельзя вызывать ConfigEditor.edit из активации helper-плагина (вложенная транзакция внутри HMR отвергается) — изменение выполняется отдельным явно разрешённым действием после активации.
