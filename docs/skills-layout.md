# Конвенции артефактов скиллов (layout)

Зафиксировано по открытой спецификации [Agent Skills (agentskills.io)](https://agentskills.io/specification) — de-facto стандарт ( progressive disclosure, поддерживается кросс-клиентскими агентами). DSH нативно сканирует эти каталоги как filesystem-источники скиллов.

## Каталоги

| Уровень | Путь | DSH-источник (priority) |
|---|---|---|
| Проект (dsh) | `<projectRoot>/.dsh/skills/<name>/SKILL.md` | project-dsh (100) |
| Проект (agents) | `<projectRoot>/.agents/skills/<name>/SKILL.md` | project-agents (200) |
| Пользователь (dsh) | `~/.dsh/skills/<name>/SKILL.md` | user-dsh (400) |
| Пользователь (agents) | `~/.agents/skills/<name>/SKILL.md` | user-agents (500) |

`projectRoot` — ближайший каталог с маркером (`.git`), найденный подъёмом от cwd; при отсутствии маркера — cwd. Skillgrowth экспортирует в `.agents/skills`-ветку (project → home → cwd), путь `~/.agents/skills` эквивалентен home-фолбэку.

## Структура бандла скилла

```
learned-example/
├── SKILL.md           # обязателен: YAML frontmatter + markdown body
├── scripts/           # опционально: исполняемый код (non-interactive!)
├── references/        # опционально: подробная документация, подгружается по требованию
├── assets/            # опционально: шаблоны, изображения, данные
└── evals/             # опционально: evals.json — тест-кейсы скилла
```

## SKILL.md

- **Frontmatter**: `name` (обязателен, == имя каталога, 1–64, lowercase kebab, без leading/trailing/consecutive hyphens); `description` (обязателен, 1–1024, императив «Use this skill when…», несёт всю нагрузку триггера); опционально `license`, `compatibility`, `metadata`, `allowed-tools`.
- **Body**: ≤500 строк / ~5000 токенов. Детали — в `references/`. Обязательны gotchas (неочевидные факты), шаги, примеры, чек-листы.
- **Скрипты**: только non-interactive (TTY-hang), флаги/env/stdin вместо промптов, структурный вывод в stdout, диагностика в stderr, `--help`, относительные пути от корня скилла, пиновать версии (`npx pkg@ver`).
- **Валидация**: `skills-ref validate ./skill-name` (frontmatter и naming).

Skillgrowth генерирует только `SKILL.md` (+ sidecar `.skillgrowth.json` с `{scopeHash, revision, candidateHash, exportedAt}` — служебный, не часть спеки). Каталоги `scripts/`, `references/`, `assets/` — пользовательская зона: плагин их не трогает и не удаляет. Ручные правки экспортированного `SKILL.md` детектируются как drift и не затираются молча.

## Где что хранится (проект dsh-skillgrowth)

- Исходники плагина: `src/` (runtime в `src/runtime-v0.3.0/`, development-источник — те же файлы в `src/`).
- Тесты плагина: `tests/*.test.mjs` (`node --test`); native fixtures — `src/bench/native-cases.js`.
- Тесты скиллов (evals): per-skill `evals/evals.json` (спека) + project-level trusted paired case sets через `declarativeCaseSetsJson` (registry host-owned, adaptation+holdout split).
- Документация: `README*.md`, `docs/*.md` репозитория; per-skill детали — `references/` внутри бандла.
- Создание/правка/слияние: создаётся дельтой `create` (Curator/GEPA-lite), правится дельтами `insert`/`replace`/`archive` с exact-hash optimistic concurrency, слияние (recombine) — host-side merge непересекающихся правок + дельта; всё версионируется в KV, экспорт — derived mirror.
