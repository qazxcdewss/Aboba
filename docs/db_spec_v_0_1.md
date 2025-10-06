# DB Spec v0.1 — Aboba

**Статус:** draft → review → **approved** (после твоего ок)

**Источник истины:** этот документ + ADR-001…010 + Whitepaper V2. Все правила ниже соответствуют тем файлам и договорённостям из чата; ничего нового не вводим.

**Версионирование:** любые изменения схемы/enum/инвариантов → bump версии (v0.2, v0.3…) + запись в Changelog + ссылка на ADR.

---

## 0. Конвенции
- БД: PostgreSQL 15+.
- Таймстемпы: `timestamptz` (UTC).
- Идентификаторы: `bigserial` PK, имена в `snake_case`.
- Ограничения и индексы обязаны быть перечислены у каждой таблицы.
- Частичные уникальные индексы используем для бизнес-инвариантов (пример: уникальный телефон только у публикуемых анкет).
- Файлы медиа: оригиналы приватные, публика — через derived-версии. Presigned URL **10 минут** (устоялось; заменить прежние «1 мин» в Whitepaper/ADR-010).
- Фото: максимум 25 MB.

---

## 1. Enum-реестр (фиксируем значения)
**profile_status**: `draft`, `submitted`, `pending_moderation`, `publishable`, `needs_fix`, `rejected`, `published`, `archived`.

**price_time_band**: `day`, `night`.

**price_visit_type**: `incall`, `outcall`.

**price_unit**: `1h`, `2h`, `night`, `other`.

**price_outcall_travel**: `none`, `client_taxi`, `included`.

**billing_transaction_direction**: `in`, `out`.

**billing_transaction_kind**: `deposit`, `charge`, `refund`, `adjustment`.

**billing_invoice_state**: `pending`, `expired`, `confirmed`, `canceled`.

**publication_order_state**: `pending`, `paid`, `expired`, `cancelled`.

**moderation_task_status**: `queued`, `sent_to_tg`, `voting`, `resolved`, `canceled`.

**moderation_decision**: `approved`, `needs_fix`, `rejected`.

> Любое изменение набора значений требует обновления этого раздела и соответствующего ADR.

---

## 2. Таблицы

### 2.1 `profiles` — ядро анкеты
**Назначение:** карточка анкеты, жизненный цикл публикации.

**Поля:**
- `id` bigserial PK
- `user_id` bigint FK → `auth.users(id)` ON DELETE RESTRICT
- `status` `profile_status` NOT NULL DEFAULT `draft`
- `category_id` bigint FK → `profile_categories(id)` ON DELETE RESTRICT
- `nickname` varchar(30) NOT NULL
- `title_en` varchar(200) NULL
- `short_bio` varchar(130) NULL
- `full_description` text NULL
- `contact_phone_e164` varchar(20) NULL
- `contact_telegram_username` varchar(32) NULL
- `contact_whatsapp` boolean NOT NULL DEFAULT false
- `contact_viber` boolean NOT NULL DEFAULT false
- `preferred_from_hour` smallint NULL (0..23)
- `preferred_to_hour` smallint NULL (0..23)
- `answers_calls/sms/telegram/whatsapp/viber` boolean NOT NULL DEFAULT false
- `age_min_customer` smallint NULL (≥18)
- `age_max_customer` smallint NULL (≤99; ≥min)
- `is_visible` boolean NOT NULL DEFAULT false
- `published_at` timestamptz NULL
- `expires_at` timestamptz NULL
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

**Инварианты / CHECK:**
- `preferred_*_hour BETWEEN 0 AND 23` (если не NULL)
- `age` границы: 18..99 и `min ≤ max`
- если `contact_whatsapp = false` ⇒ `answers_whatsapp = false`; аналогично для viber
- если `status = 'published'` ⇒ `published_at IS NOT NULL`

**Уникальности/Индексы:**
- **Partial UNIQUE**: `(contact_phone_e164)` при `status IN ('publishable','published')` и `contact_phone_e164 IS NOT NULL`
- Индекс витрины: `(status, is_visible, category_id)`
- `(updated_at)`

**Примечания:** `is_visible` не должен становиться `true` вне статусов `publishable/published` (контролируем на уровне сервиса; при желании — дополнительный CHECK).

**Связанные ADR:** ADR-006 (Profiles), ADR-004 (Media, косвенно — витрина), ADR-007 (Publication flow).

---

### 2.2 `services` — справочник услуг
**Назначение:** каталог чекбоксов (группы: sex / massage / strip / extreme / sado_maso / misc).

**Поля:**
- `id` bigserial PK
- `group_code` text NOT NULL CHECK IN перечислении выше
- `code` text NOT NULL UNIQUE (UPPER_SNAKE_CASE)
- `name` text NOT NULL
- `description` text NULL
- `requires_note` boolean NOT NULL DEFAULT false
- `is_active` boolean NOT NULL DEFAULT true
- `position` smallint NOT NULL DEFAULT 100
- `i18n` jsonb NULL
- `created_at`, `updated_at` timestamptz NOT NULL DEFAULT now()

**Индексы:**
- `UNIQUE(code)`
- `UNIQUE(group_code, code)` (для защиты от дублей в группе)
- `(is_active, group_code, position)`

**Связанные ADR:** ADR-006.

---

### 2.3 `profile_services` — выбранные услуги (m2m)
**Назначение:** реальные выборы пользователя для конкретной анкеты.

**Поля:**
- `id` bigserial PK
- `profile_id` bigint NOT NULL FK → `profiles(id)` ON DELETE CASCADE
- `service_id` bigint NOT NULL FK → `services(id)`
- `note` text NULL (если `services.requires_note=true` — **обязателен**)
- `created_at` timestamptz NOT NULL DEFAULT now()

**Ограничения/Индексы:**
- `UNIQUE(profile_id, service_id)`
- `INDEX(profile_id)`; `INDEX(service_id)`
- Бизнес-правило: максимум **25** строк на профиль (реализуем триггером в реализации; здесь фиксируем как обязательное правило)

**Связанные ADR:** ADR-006.

---

### 2.3b `profile_custom_services` — «Только у меня» (свободный текст)
**Назначение:** произвольные текстовые дополнения к анкете, когда нужно указать уникальные особенности вне справочника.

**Поля:**
- `id` bigserial PK
- `profile_id` bigint NOT NULL FK → `profiles(id)` ON DELETE CASCADE
- `text` text NOT NULL  — краткое описание услуги/особенности
- `created_at` timestamptz NOT NULL DEFAULT now()

**Индексы:**
- `INDEX(profile_id)` — быстрый доступ

**Примечания:** обычно 1–3 записи на анкету; отображаются отдельным блоком «Только у меня». (Ограничение по количеству — бизнес-правило уровня приложения.)

---



### 2.4 `profile_prices` — расценки анкеты (матрица)
**Назначение:** цены по комбинациям «время суток × формат визита × длительность». В профиле должна быть **хотя бы одна** цена (валидируем на переходе `draft → submitted`).

**Поля:**
- `id` bigserial PK
- `profile_id` bigint NOT NULL FK → `profiles(id)` ON DELETE CASCADE
- `time_band` `price_time_band` NOT NULL
- `visit_type` `price_visit_type` NOT NULL
- `unit` `price_unit` NOT NULL
- `amount_minor` bigint NOT NULL (рекоменд. 1..30_000_000)
- `currency` text NOT NULL
- `outcall_travel` `price_outcall_travel` NOT NULL DEFAULT `none`
- `note` text NULL (для `unit='other'` — обязателен)
- `updated_at` timestamptz NOT NULL DEFAULT now()

**Инварианты / CHECK:**
- `UNIQUE(profile_id, time_band, visit_type, unit)`
- если `visit_type='incall'` ⇒ `outcall_travel='none'`
- если `unit='other'` ⇒ `note IS NOT NULL AND note<>''`

**Индексы:** `INDEX(profile_id)`, `INDEX(visit_type, time_band)`

**Связанные ADR:** ADR-006.

---

### 2.5 `profile_photos` — медиа анкеты (фото)
**Назначение:** хранение метаданных фото (оригиналы приватно; раздача только derived).

**Поля (ключевые):**
- `id` bigserial PK
- `profile_id` FK → `profiles(id)` ON DELETE CASCADE
- `s3_original_key` text NOT NULL (приватный бакет)
- `s3_thumb_key` text NULL, `s3_card_key` text NULL, `s3_watermarked_key` text NULL (derived)
- `sha256_hex` char(64) NOT NULL (анти-дубль внутри профиля)
- `is_cover` boolean NOT NULL DEFAULT false (единственная обложка)
- `position` smallint NOT NULL DEFAULT 100 (уникальный порядок в рамках профиля)
- `size_bytes` int NOT NULL (≤ 25 MB)
- `mime` text NOT NULL (строгий allowlist)
- `nsfw_label` text NULL; `ai_payload` jsonb NULL
- `created_at`, `updated_at` timestamptz DEFAULT now()

**Ограничения/Индексы:**
- `UNIQUE(profile_id, sha256_hex)` (анти-дубли)
- `UNIQUE(profile_id, position)`; `partial UNIQUE (profile_id) WHERE is_cover=true`
- `(profile_id)`; `WHERE is_cover=true` под витрину

**Политики:**
- Количество фото на профиль: **от 3 до 30** (бизнес-правило; может дублироваться триггером).
- EXIF-strip, antivirus, resize, watermark на derived; оригиналы не раздаются.
- Presigned URL (GET/PUT) = **10 минут**.


**Связанные ADR:** ADR-004, ADR-006.

---

### 2.6 `profile_videos` — видео анкеты (опционально)
**Поля (минимум):** `id` PK, `profile_id` FK, `kind ('public'|'verification')`, `s3_original_key`, `s3_poster_key`, `size_bytes`, `mime`, `is_active`, `created_at/updated_at`.

**Правила:** максимум одно активное видео каждого вида; derived-постер обязателен для витрины.

**Связанные ADR:** ADR-004.

---

### 2.7 `moderation_tasks`
**Назначение:** этап ИИ-проверки и ручного голосования в TG.

**Поля:**
- `id` bigserial PK
- `profile_id` bigint FK → `profiles(id)`
- `status` `moderation_task_status` NOT NULL DEFAULT `queued`
- `priority` smallint NOT NULL DEFAULT 0
- `ai_score` numeric(6,3) NULL
- `ai_payload` jsonb NULL (ограниченный срок хранения)
- `tg_chat_id` bigint NULL, `tg_message_id` int NULL, `tg_topic_id` int NULL
- `votes_up` int NOT NULL DEFAULT 0, `votes_down` int NOT NULL DEFAULT 0
- `created_at` timestamptz DEFAULT now(), `updated_at` timestamptz DEFAULT now()

**Индексы:** `(profile_id)`, `(status, priority)`, `(created_at)`

**Связанные ADR:** ADR-005, ADR-010.

---

### 2.8 `moderation_decisions`
**Назначение:** финальное решение модерации + снапшот AI-данных.

**Поля:**
- `id` bigserial PK
- `task_id` bigint NOT NULL FK → `moderation_tasks(id)` ON DELETE CASCADE
- `profile_id` bigint NOT NULL FK → `profiles(id)` ON DELETE CASCADE
- `decision` `moderation_decision` NOT NULL
- `reason` text NULL
- `ai_snapshot` jsonb NULL (копия payload на момент решения)
- `moderator_telegram_id` bigint NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

**Индексы:** `(task_id)`, `(profile_id)`

**Связанные ADR:** ADR-005, ADR-010.

---

### 2.9 Billing: `billing_invoices`
**Назначение:** инвойсы на пополнение (amount-tagging / адрес+memo).

**Поля (ключевые):** `id PK`, `user_id` FK, `chain`, `address`, `memo_tag`, `asset`, `exact_amount_minor`, `currency`, `expires_at`, `state billing_invoice_state`, `created_at/updated_at`.

**Индексы:** `(user_id)`, `(state, expires_at)`.

**Правила:** подтверждение по ончейн-событиям → `confirmed`.

**Связанные ADR:** ADR-007.

---

### 2.10 Billing: `billing_onchain_txs`
**Назначение:** зафиксированные ончейн-транзакции, связанные с инвойсами/пополнениями.

**Поля:** `id PK`, `invoice_id FK`, `tx_hash`, `confirmations int`, `confirmed_at timestamptz NULL`, `chain_lag_blocks int`, `created_at`.

**Уникальности:** `UNIQUE(chain, tx_hash)`.

**Связанные ADR:** ADR-007.

---

### 2.11 Billing: `billing_transactions`
**Назначение:** движение средств внутри системы (идемпотентно).

**Поля:** `id bigserial PK`, `user_id FK`, `direction billing_transaction_direction`, `kind billing_transaction_kind`, `amount_minor bigint`, `currency text`, `idempotency_key text UNIQUE`, `money_source text`, `created_at`.

**Связанные ADR:** ADR-007.

---

### 2.12 Billing: `billing_balances`
**Назначение:** текущие балансы по пользователям/валютам.

**Поля:** `user_id PK-part`, `currency PK-part`, `amount_minor bigint NOT NULL DEFAULT 0`, `updated_at`.

**Связанные ADR:** ADR-007.

---

### 2.13 Публикации: `publication_prices`
**Назначение:** тарифы на публикацию по категориям.

**Поля:** `id PK`, `category_id FK → profile_categories`, `period_days int`, `amount_minor bigint`, `currency text`, `is_active boolean`, `valid_from`, `valid_to`.

**Уникальности:** `UNIQUE(category_id, period_days, currency) WHERE is_active=true`.

**Связанные ADR:** ADR-007.

---

### 2.14 Публикации: `billing_profile_publication_orders`
**Назначение:** заказ публикации профиля; хранит **снимок** цены.

**Поля:** `id PK`, `profile_id FK → profiles`, `pricing_id FK → publication_prices(id) NULL` (может быть NULL — снимок не сломан удалением цены), `period_days`, `amount_minor`, `currency`, `state publication_order_state`, `idempotency_key UNIQUE`, `invoice_id NULL`, `created_at`, `paid_at`, `expires_at`.

**Связанные ADR:** ADR-007 (payment→publish), ADR-006 (переход профиля в published/expires).

---

### 2.15 Auth / Audit / Limits — полная спецификация

#### 2.15.1 `auth.users`
**Роль:** паспортная таблица, 1 запись = 1 человек. Все сущности ссылаются через `user_id`.

**Поля:**
- `id` bigserial PK
- `email` text NULL (нормализуется: lowercase+trim)
- `email_verified` boolean NOT NULL DEFAULT false
- `password_hash` text NULL (Argon2id/scrypt/bcrypt)
- `status` text NOT NULL CHECK IN (`'active'`,`'locked'`) DEFAULT `'active'`
- `last_login_at` timestamptz NULL
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

**Индексы:**
- partial UNIQUE `(email)` WHERE `email IS NOT NULL`
- `INDEX(last_login_at)`

**Инварианты:**
- Без `users` не может существовать ни одна `auth_identity`.

---

#### 2.15.2 `auth.auth_identities`
**Роль:** связь всех каналов входа с пользователем.

**Поля:**
- `id` bigserial PK
- `user_id` bigint NOT NULL FK → `auth.users(id)`
- `provider` text NOT NULL CHECK IN (`'email'`,`'telegram_phone'`)
- `provider_uid` text NOT NULL  — email (lowercase) или телефон E.164
- `verified_at` timestamptz NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

**Индексы:**
- UNIQUE `(provider, provider_uid)` — один канал ↔ один пользователь
- `INDEX(user_id)`
- `INDEX(telegram_user_id)` WHERE `telegram_user_id IS NOT NULL` (если используется)

---

#### 2.15.3 `auth.auth_challenges`
**Роль:** единая таблица одноразовых подтверждений/токенов (email-verify, reset, tg-verify, login-otp).

**Поля:**
- `id` bigserial PK
- `user_id` bigint NULL FK → `auth.users(id)`
- `channel` text NOT NULL CHECK IN (`'email'`,`'telegram_phone'`)
- `purpose` text NOT NULL CHECK IN (`'email_verify'`,`'password_reset'`,`'tg_verify'`,`'login_otp'`)
- `target` text NOT NULL  — email(lowercase) или телефон E.164
- `token_hash` text NULL UNIQUE
- `deep_link_hash` text NULL UNIQUE
- `state` text NOT NULL CHECK IN (`'pending'`,`'verified'`,`'expired'`) DEFAULT `'pending'`
- `meta` jsonb NULL
- `expires_at` timestamptz NOT NULL
- `verified_at` timestamptz NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

**Индексы:**
- `INDEX(target, channel, purpose, state)`
- `INDEX(expires_at)`
- (опц.) `INDEX(user_id, purpose, state)`

---

#### 2.15.4 `auth.sessions`
**Роль:** активные сессии (opaque sid-cookie).

**Поля:**
- `id` bigserial PK
- `user_id` bigint NOT NULL FK → `auth.users(id)`
- `issued_at` timestamptz NOT NULL DEFAULT now()
- `expires_at` timestamptz NOT NULL
- `revoked_at` timestamptz NULL
- `ip` text NULL
- `user_agent` text NULL

**Индексы:**
- `INDEX(user_id, expires_at)`
- (опц.) `INDEX(revoked_at)`

**Инвариант «живая сессия»:** `revoked_at IS NULL AND now() < expires_at`.

---

#### 2.15.5 `auth.rate_limits`
**Роль:** счётчики RPS/частоты для аутентификации.

**Поля:**
- `id` bigserial PK
- `subject` text NOT NULL CHECK IN (`'ip'`,`'email'`,`'phone'`,`'tg_user'`)
- `key` text NOT NULL CHECK IN (`'signup'`,`'login'`,`'email_verify'`,`'tg_verify'`,`'reset'`)
- `window_s` int NOT NULL
- `counter` int NOT NULL
- `reset_at` timestamptz NOT NULL
- `updated_at` timestamptz NOT NULL DEFAULT now()

**Индексы:** `INDEX(subject, key)`, (опц.) `INDEX(subject, key, reset_at)`

---

#### 2.15.6 `auth.audit_log`
**Роль:** INSERT-only аудит значимых событий.

**Поля:**
- `id` bigserial PK
- `actor_type` text NOT NULL CHECK IN (`'user'`,`'system'`)
- `actor_id` bigint NULL  — FK → `auth.users(id)`
- `entity_type` text NOT NULL
- `entity_id` bigint NOT NULL
- `event` text NOT NULL  — коды: `signup`, `email.verify_sent`, `email.verified`, `login.success`, `login.failed`, `tg.verify_started`, `tg.verified`, `reset.requested`, `reset.used`, …
- `payload_json` jsonb NULL  — без секретов
- `ip` text NULL, `ua` text NULL
- `created_at` timestamptz NOT NULL DEFAULT now()

**Индексы:** `INDEX(entity_type, entity_id, created_at)`, `INDEX(event, created_at)`, (опц.) `INDEX(actor_type, actor_id, created_at)`

**Политика:** без PII/секретов; ретеншн — согласно ADR-008.

---

#### 2.15.7 `auth.moderators`
**Роль:** whitelist Telegram-модераторов для доступа к модерации через бота (согласно ADR-009).

**Поля:**
- `id` bigserial PK
- `telegram_user_id` bigint NOT NULL UNIQUE
- `display_name` text NULL
- `enabled` boolean NOT NULL DEFAULT true
- `created_at` timestamptz NOT NULL DEFAULT now()
- `updated_at` timestamptz NOT NULL DEFAULT now()

**Индексы:** `INDEX(enabled)`

**Примечания:** доступ к модерации и действиям выдаётся только для записей с `enabled=true`.

