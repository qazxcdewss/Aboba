# ADR-008 — Observability & Operations (без веб-админки)

---

## 1. Решение (Summary)

**Принцип:** нет веб-админки. Все операции и диагностика проходят через Telegram-бот и CLI.

- **Telegram-бот:** для модерации и базовых операций (отмена задач, пересоздание, статус профилей).
- **CLI / ops-скрипты:** для глубинных операций (requeue DLQ, resettle инвойсов, ручные override, реиндексация).
- **Наблюдаемость:** Prometheus-метрики, health-чеки, структурные JSON-логи, алерты.
- **Доступ:** только через приватную сеть/VPN/allowlist. CLI запускается как ECS-задача или через SSH jump host.

---

## 2. Ops-интерфейсы

### 2.1 Telegram-бот (расширенный)

Команды под `TelegramModeratorGuard` и whitelist:

```
/task cancel <taskId> <reason>     — пометить задачу как canceled.
/dlq size                         — посмотреть размер DLQ.
/dlq requeue <queue> <jobId>      — переотправить задачу.
/invoice resettle <invoiceId>     — повторить settle инвойса (идемпотентно).
/profile override <profileId> <toStatus> <reason> — изменить статус профиля (по процедуре).
```

Все команды требуют `reason` и фиксируются в `auth.audit_log`.

### 2.2 CLI / скрипты

Запуск из приватного окружения (ECS one-off task или контейнер):

```
ops:dlq:requeue --queue=media.process_photo --jobId=...
ops:invoice:resettle --invoiceId=...
ops:profile:override --profileId=... --to=published --reason="..."
ops:mv:refresh-min-price
```

Аутентификация через переменные окружения и Secret Manager.

---

## 3. Метрики (Prometheus)

| Категория      | Метрики                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **API**        | `http_requests_total{route,code}`, `http_request_duration_seconds_bucket{route}`                                                                            |
| **Медиа**      | `media_queue_length{queue}`, `media_process_failures_total{reason}`, `media_process_duration_seconds_bucket`                                                |
| **Модерация**  | `moderation_time_to_decision_seconds_bucket`, `moderation_decisions_total{decision}`, `moderation_tasks_open{state}`                                        |
| **Биллинг**    | `billing_watch_lag_blocks{chain}`, `billing_tx_total{kind,status}`, `billing_deposit_settle_duration_seconds_bucket`, `billing_balance_sum_minor{currency}` |
| **Публикации** | `publication_active_total`, `publication_expire_jobs_pending`                                                                                               |
| **Инфра**      | `db_pool_in_use_connections`, `redis_connected_clients`, `nodejs_eventloop_lag_seconds`                                                                     |

---

## 4. Health-чеки

| Endpoint        | Назначение                                                    |
| --------------- | ------------------------------------------------------------- |
| `/health/live`  | Проверяет жив ли процесс.                                     |
| `/health/ready` | Проверяет доступность БД, Redis, S3, RPC; миграции применены. |
| `/health/deps`  | JSON-диагностика зависимостей.                                |

Ingress (ALB) мониторит `/health/ready`.

---

## 5. Логи

- **Формат:** JSON (pino): `ts`, `level`, `msg`, `request_id`, `job_id`, `telegram_user_id`.
- **Без PII:** почта и Telegram ID маскированы.
- **Корреляция:** `request_id` прокидывается во все очереди и фоновые задачи.

---

## 6. Алерты

| Условие                                          | Реакция          |
| ------------------------------------------------ | ---------------- |
| API 5xx > 1% за 5 мин                            | Page             |
| p95 latency > 800ms за 10 мин                    | Ticket           |
| media\_process\_failures\_total всплеск          | Page             |
| media\_queue\_length > порога                    | Warning          |
| moderation\_time\_to\_decision\_seconds p95 > 2ч | Уведомление в TG |
| billing\_watch\_lag\_blocks{chain} > 3           | Warning          |
| Балансовая инварианта нарушена                   | Page             |
| DB pool usage > 80% 10 мин                       | Warning          |

---

## 7. Runbooks (операционные процедуры)

### 7.1 Зависла модерация

1. Проверить `moderation_tasks` с `state ∈ ('sent_to_tg','voting')` старше 4ч.
2. Проверить Telegram webhook и ретраи в `moderation.post_to_tg`.
3. При осиротевшем объекте — `/task cancel <id> <reason>`.
4. Зафиксировать инцидент.

### 7.2 DLQ растёт

1. Изучить `error` нескольких задач.
2. При внешней причине — `dlq requeue`.
3. При кодовой — завести баг, при необходимости `cancel` с reason.

### 7.3 Платёж не зачислился

1. Проверить `billing_onchain_txs` и confirmations.
2. Выполнить `/invoice resettle <invoiceId>`.
3. Если не помогло — ручной `adjust` через CLI.

### 7.4 Override статуса профиля

1. `/profile override <profileId> <toStatus> <reason>`.
2. Записать `profiles.status_override (before/after)`.
3. Триггерить `profile.published|archived` для обновления кэшей.

Feature flag включается только на время операции.

---

## 8. Безопасность

- **Единственная панель:** Telegram-бот + CLI.
- **Telegram webhook:** IP allowlist, секрет в URL, валидация схемы апдейта, rate-limits.
- **CLI:** только из VPN, секреты из Secret Manager.
- **Без публичных админ-эндпойнтов.**
- **Аудит:** все действия с `reason` в `auth.audit_log`.

---

## 9. DoD (Definition of Done)

- Реализованы команды бота (cancel, requeue, resettle, override) с аудитом.

- CLI-утилиты задокументированы.

- Метрики, алерты и health-чеки активны.

- Нет публичных админ-эндпойнтов.





**Резюме:**\
ADR-008 закрепляет модель наблюдаемости и операций без веб-админки: вся админская активность через Telegram и CLI, с полным аудитом, безопасностью и автоматизацией инфраструктуры.

