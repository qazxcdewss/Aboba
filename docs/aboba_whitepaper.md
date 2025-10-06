# Aboba Whitepaper  (Source of Truth)

---

## Введение

**Aboba** — цифровая платформа для размещения, верификации и модерации анкет в индустрии эскорт-услуг под юрисдикцией Нидерландов.\
Проект создаёт безопасную, легальную и прозрачную экосистему, где каждая анкета проходит AI-анализ и ручную проверку модераторами через Telegram.

**Цели:**

- Законность, прозрачность и соответствие AML / GDPR.
- Минимизация фрода и дубликатов через FaceMatch и AI Consistency.
- Human-in-the-loop модерация.
- Полностью автономная публикация и оплата анкеты без участия администрации.
- Ончейн-биллинг и криптовалютный баланс.

Aboba строится как модульный, событийный бэкэнд (ADR-001–010) с чёткой изоляцией доменов, гарантированной идемпотентностью и AI-first подходом.

---

## Архитектурные принципы

**Основные модули (см. ADR-002):**

- `auth` — пользователи, сессии, Telegram ID.
- `profiles` — анкеты, фото, прайсы, услуги.
- `moderation` — AI-анализ, Telegram-модерация.
- `billing` — ончейн-инвойсы, транзакции, балансы.
- `publication` — платные публикации и сроки.
- `ops` — метрики, CLI и Telegram-команды.

**Архитектура событий:** transactional outbox + BullMQ очереди.\
Каждый домен публикует события в Event Bus и подписывается на смежные (см. ADR-001).

**Основные события:**

```
profile.submitted
media.photo.processed
moderation.task.created
moderation.decision.applied
billing.deposit.confirmed
billing.charge.confirmed
publication.order.paid
```

---

## Основной функционал (Production)

### 1. Регистрация и авторизация (ADR-003)

- Email или Telegram OTP (passwordless).
- Нет JWT или refresh-токенов.
- Сессии `sid` (HttpOnly cookie, TTL 30 дней).
- Telegram используется как админ-интерфейс.

### 2. Создание анкеты

- Фото: 3–30 (JPEG/PNG/WebP, ≤25 МБ).
- Обязательное селфи с листком `ABOBA IDxxxxxx`.
- Поля: имя, возраст, параметры, описание, контакты.
- Прайсы: таблица `profile_prices` (time\_band × visit\_type × unit).
- Минимум 1 активная цена.

### 3. AI-анализ и приоритизация (ADR-010)

AI Worker использует AWS Rekognition и Textract:

- `DetectModerationLabels` — NSFW, Drugs, Violence.
- `DetectFaces` — лица, позы, яркость, резкость.
- `CompareFaces` — сверка селфи и фото анкеты.
- `Textract` — OCR кода `ABOBA IDxxxxxx`.

Результаты сохраняются в `ai_payload` + `ai_score`, вычисляется `priority`.

**AI Policy:**

| ai\_score | consistency | Priority | Risk   |
| --------- | ----------- | -------- | ------ |
| >0.7      | любое       | 10       | High   |
| 0.3–0.7   | ≥0.6        | 50       | Medium |
| <0.3      | ≥0.65       | 90       | Low    |

ИИ не принимает решений — только приоритизирует Telegram-модерацию.

### 4. Telegram-модерация (ADR-005, ADR-009)

- Все задачи `moderation_tasks` отправляются в Telegram.
- Карточка включает:
  ```
  #123 • profile:45 • photo
  AI: Risk 0.18 (Low)
  NSFW: 0.02 / Suggestive: 0.12
  Faces: 0.91, 0.88, 0.84
  Consistency: 0.76 (cov 0.8 coh 0.7)
  OCR: match=YES overlay=NO
  [Approve] [Needs Fix] [Reject]
  ```
- Решение фиксируется в `moderation_decisions` с `ai_snapshot`.

---

## 5. Оплата и публикация (ADR-006–007)

- Пополнение криптовалютой (BTC, ETH, SOL, XRP, USDT).
- `billing_invoices` — уникальные on-chain адреса/memo.
- `billing_transactions` — единый источник истины.
- `billing_balances` агрегирует confirmed-транзакции.
- Публикация: `charge → publication_order.paid → profile.published`.

**API (MVP):**

```
POST /v1/billing/invoices {asset}
GET /v1/billing/balance
POST /v1/billing/publication-orders {profileId, periodDays}
POST /v1/billing/publication-orders/:id/pay {idempotencyKey}
```

**Идемпотентность:** через `idempotency_key` во всех таблицах.

---

## 6. Безопасность и приватность (ADR-003, ADR-009)

- Нет JWT и refresh-токенов. Только `sid` + Telegram whitelist.
- Админ-интерфейса нет: модерация и ops — через Telegram и CLI.
- Presigned URLs (TTL 10 мин).
- Все действия в `auth.audit_log` (actor\_type, reason, ref\_type, ref\_id).
- Secrets в AWS Secrets Manager.
- VPN + IP allowlist для CLI.

---

## 7. Observability & Ops (ADR-008)

- **Метрики:** Prometheus (`http_requests_total`, `media_queue_length`, `billing_balance_sum_minor`).
- **Health:** `/health/live`, `/health/ready`, `/health/deps`.
- **Алерты:** latency, DLQ, billing mismatch, moderation lag.
- **Runbooks:** cancel stuck task, resettle invoice, requeue DLQ.
- **Команды бота:** `/task cancel`, `/dlq requeue`, `/invoice resettle`, `/profile override`.

---

## 8. Техническая архитектура

| Слой       | Технологии                                  |
| ---------- | ------------------------------------------- |
| Backend    | Node.js (NestJS), PostgreSQL, Redis, BullMQ |
| AI Layer   | AWS Rekognition + Textract                  |
| Storage    | S3 (MinIO / AWS S3)                         |
| Messaging  | Telegram Bot API                            |
| Deployment | Docker, ECS (Fargate), RDS                  |
| Monitoring | Prometheus + Grafana                        |

**Очереди:** `media.process_photo`, `moderation.post_to_tg`, `billing.settle`, `publication.expire`.

---

## 9. Roadmap

| Этап               | Описание                                 |
| ------------------ | ---------------------------------------- |
| Verified+          | Видео FaceMatch + AI motion check        |
| Auto-policy        | Автопубликация low-risk профилей (pilot) |
| InsightFace ONNX   | Локальный AI inference без AWS           |
| LLM Explainability | Объяснение оценок AI для модераторов     |
| Dashboard          | Веб-дэшборд с аналитикой и AI метриками  |

---

## 10. Источники истины

**Source of Truth:**

1. Aboba Whitepaper  (текущий документ)
2. ADR-001–010 (архитектурные решения)
3. DB Spec  (структура данных)

Все три документа синхронизированы и обязательны к исполнению при разработке.

---

## Итог

Aboba — зрелая, модульная платформа с полной связкой AI-анализ → Telegram-модерация → on-chain биллинг → публикация.\
Система устойчива, идемпотентна, безопасна и готова к продакшн-развёртыванию.

