# ADR-005 — Moderation (TG-first, без веб-админки)

---

## 1. Решение (Summary)

**Единица модерации:** `moderation_tasks` (одна активная на профиль или медиа-объект).

**Telegram-first:** карточки задач отправляются в Telegram-чат(ы). Все голоса и финальные решения принимаются **только** пользователями, чьи `telegram_user_id` присутствуют в whitelist.

**Финал:** при принятии решения создаётся запись в `moderation_decisions`; атомарно обновляется `profiles.status` и помечается задача как `resolved`.

**Агрегация голосов:** хранится в `moderation_tasks`; снэпшоты (голоса, AI-оценки) сохраняются в `moderation_decisions`.

**Нет веб-ролей **``** / **``**:** вся авторизация производится через бота. Только Telegram ID из whitelist имеют право действий.

---

## 2. Состояния и инварианты

**state:** `queued → sent_to_tg → voting → resolved | canceled`

**CHECK-инварианты:**

| kind          | Условие                                                |
| ------------- | ------------------------------------------------------ |
| profile\_full | `target_photo_id IS NULL AND target_video_id IS NULL`  |
| photo         | `target_photo_id NOT NULL AND target_video_id IS NULL` |
| video         | `target_video_id NOT NULL AND target_photo_id IS NULL` |

**UNIQUE активной задачи:**

```sql
UNIQUE (profile_id, kind, coalesce(target_photo_id, 0), coalesce(target_video_id, 0))
WHERE state IN ('queued','sent_to_tg','voting');
```

**Маппинг решения → статус профиля:**

| decision   | profile.status |
| ---------- | -------------- |
| approved   | publishable    |
| needs\_fix | needs\_fix     |
| rejected   | rejected       |

---

## 3. Реестр полномочий (whitelist)

**Таблица **``**:**

| Поле               | Тип               | Описание               |
| ------------------ | ----------------- | ---------------------- |
| id                 | PK                |                        |
| telegram\_user\_id | BIGINT UNIQUE     | Telegram ID модератора |
| display\_name      | TEXT              | Имя модератора         |
| enabled            | BOOL DEFAULT true | Активен / выключен     |
| created\_at        | timestamptz       |                        |
| updated\_at        | timestamptz       |                        |

Только пользователи из этой таблицы имеют право голосовать и принимать решения.

---

## 4. Telegram Webhook и Guard

**TelegramModeratorGuard:**

- Проверяет источник (IP из allowlist Telegram + секрет вебхука).
- Извлекает `telegram_user_id` из `update`.
- Проверяет наличие и активность (`enabled=true`) в `auth.moderators`.

Guard применяется ко всем эндпойнтам вебхука и модерации.

---

## 5. Очереди и карточки задач

**Очередь:** `moderation.post_to_tg`

**Задача:** отправляет карточку в Telegram-чат и записывает `tg_chat_id`, `tg_message_id`, `sent_to_tg_at` в `moderation_tasks`.

**Пример карточки:**

```
#<taskId> • profile_full | profile:<id>

Анкета: Имя, возраст, город
Обложка: (фото)
ИИ: nsfw_score=0.14, completeness=92%

[Approve] [Needs fix] [Reject]
```

**Fallback-команды:** `/vote approve|needs_fix|reject`, `/decision <variant>`.

---

## 6. HTTP-контракты (внутренние, вызываются ботом)

**POST /v1/moderation/tasks/****:taskId****/vote**

```json
{ "vote": "approve|needs_fix|reject", "voterTelegramUserId": 100500 }
```

→ `202`

- Доступно при `state ∈ {'sent_to_tg','voting'}`
- Инкрементирует счётчики `votes_*`, обновляет `last_vote_at=now()`, переводит `state='voting'`.

**POST /v1/moderation/tasks/****:taskId****/decision**

```json
{
  "decision": "approved|needs_fix|rejected",
  "reasonCode": "?",
  "notes": "?",
  "decidedByTelegramUserId": 100500
}
```

→ `201`

**Транзакция:**

1. `INSERT moderation_decisions (snapshot votes, ai_snapshot)`.
2. `UPDATE profiles.status` по маппингу.
3. `UPDATE moderation_tasks.state='resolved'`.
4. `EMIT moderation.decision.applied`.
5. `INSERT auth.audit_log`.

**Идемпотентность:**

- `UNIQUE(task_id)` в `moderation_decisions`.
- Webhook idemKey: `tg:decision:<taskId>:<deciderId>`.

---

## 7. События домена

**emit:**

- `moderation.task.created`
- `moderation.decision.applied`

**listen:**

- `profile.submitted` → создать задачу `profile_full`
- `media.photo.processed` → создать photo-задачи (при необходимости)

---

## 8. Антизлоупотребления и лимиты

- **Один голос на Telegram-пользователя:** через `moderation_votes(task_id, voter_tg_id)` с `UNIQUE`.
- **Rate limits:** `/vote` — 60/ч/пользователь, `/decision` — 30/ч/пользователь.
- **Отмена задачи:** только через бота (`reason` обязателен), `state='canceled'`.

---

## 9. Аудит

Каждое действие (голос, решение, отмена) фиксируется в `auth.audit_log`:

| Поле                      | Значение                 |
| ------------------------- | ------------------------ |
| actor\_type               | `'telegram'`             |
| actor\_telegram\_user\_id | ID модератора            |
| task\_id                  | ID задачи                |
| profile\_id               | ID профиля               |
| payload                   | JSON с деталями действия |

---

## 10. Definition of Done (DoD)

- Таблица `auth.moderators` + CRUD (вкл/выкл модераторов)
- Guard `TelegramModeratorGuard` работает на вебхуке и ручках
- Очередь `moderation.post_to_tg` создаёт карточки и фиксирует `tg_message_id`
- `/vote` и `/decision` — атомарные и идемпотентные
- Аудит всех действий включён
- Интеграционные тесты: happy-path, повторное решение, удалённое медиа, ретраи Telegram, лимиты

---

**Резюме:**\
ADR-005 фиксирует Telegram-first модель модерации без веб-админки. Все действия проходят через Telegram-бота с полной идемпотентностью и аудитом. Архитектура обеспечивает прозрачность, безопасность и простоту интеграции с остальными доменами Aboba.

