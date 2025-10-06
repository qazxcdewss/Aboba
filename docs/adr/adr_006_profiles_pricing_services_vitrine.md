# ADR-006 — Profiles, Pricing, Services, Vitrine

---

## 1) Решение (Summary)

- **Единое ядро:** таблица `profiles` (владелец — модуль `profiles`).
- **Автомат статусов:** `draft → submitted → pending_moderation → publishable → published`\
  ответвления: `needs_fix`, `rejected`; финал — `archived`.
- **Готовность к submit:** ≥ **3** обработанных фото (`processed`) + ≥ **1** валидная цена + заполнены обязательные поля.
- **Прайс‑матрица:** уникальная комбинация на профиль `time_band × visit_type × unit`.
- **Услуги:** справочник `services` + связующая `profile_services` (≤ **25** штук) + свободный список `profile_custom_services`.
- **Витрина:** публичные list/detail‑ручки; раздаём **только derived** изображения по **signed URL**, TTL **10 минут**; фильтры и сортировки индексируемы.

---

## 2) Статусы и переходы (автомат)

### 2.1 Статусы `profiles.status`

```
draft → submitted → pending_moderation → (publishable → published)
                                         ↘ needs_fix
                                          ↘ rejected
published → archived
needs_fix → submitted
```

### 2.2 Бизнес‑правила переходов

- `draft → submitted` только если `isReadyToSubmit(profileId) == true`.
- `submitted` создаёт `moderation_task(profile_full)` и переводит профиль в `pending_moderation`.
- `publishable` устанавливается решением модерации `approved` (см. ADR‑005).
- `published` ставится **только** после успешной оплаты `publication_order` (идемпотентная транзакция в Billing; см. ADR‑007).
- `needs_fix` и `rejected` — итог модерации; из `needs_fix` владелец может снова `submit`.
- `archived` — ручное скрытие; обратный переход только служебно (см. Guards ниже).

### 2.3 Техническая защита

- Триггер‑гард `profiles_status_guard` блокирует нелегальные переходы.
- При публикации выставляется `published_at` (и опционально `expires_at` по заказу). `expires_at` не участвует в фильтрах витрины — статус определяет видимость.

---

## 3) Готовность к submit (проверка)

Функция `ProfilesPublicService.isReadyToSubmit(profileId)` возвращает `{ ok, reasons[] }`.

**Условия:**

- `photos_processed_count(profileId) ≥ 3`.
- `profile_prices.count(profileId) ≥ 1`.
- `required_fields_filled` (минимум: `nickname`, `category_id`, контактная политика/телеграм и др.).
- Нет фото в `processing_state='failed'`, помеченного как cover.

**Реализация:** один SQL с `JOIN/LATERAL` для подсчётов; список обязательных полей хранится в конфиге модуля и синхронизируется с валидацией DTO.

---

## 4) Прайсы и услуги

### 4.1 `profile_prices`

- **Уникальность:** `UNIQUE (profile_id, time_band, visit_type, unit)`.
- **Валидации:**
  - `amount_minor > 0` (рекоменд. 1..30\_000\_000);
  - `outcall_travel` имеет смысл **только** при `visit_type='outcall'` (для `incall` — `'none'`).
  - `unit='other'` ⇒ `note` обязателен.
- **Upsert батчем:** `PUT /v1/me/profiles/:id/prices` принимает **полный слепок** матрицы; в транзакции:
  - удаляет отсутствующие,
  - обновляет изменённые,
  - добавляет новые.
- **Индексы:** `(profile_id, time_band, visit_type, unit)`, и `(visit_type, time_band)`.

### 4.2 `services` / `profile_services`

- **Ограничение:** до **25** услуг на профиль.
- `services` содержит `code`, `group_code`, `requires_note`.
- При привязке услуги с `requires_note=true` поле `note` **обязательно**.
- **Индексы:** `UNIQUE (profile_id, service_id)`; `(profile_id)`, `(service_id)`.

### 4.3 `profile_custom_services`

- Неформализованные услуги (свободный текст), лимит по количеству (напр. ≤ **20**) и длине строки (≤ **120** символов) — бизнес‑правило уровня приложения.

---

## 5) Медиа (связь с ADR‑004)

- `profile_photos`: ровно одна обложка — `UNIQUE (profile_id) WHERE is_cover=true`.
- Порядок уникален: `UNIQUE (profile_id, position|order_index)`.
- Анти‑дубль: `UNIQUE (profile_id, sha256)`.
- `isReadyToSubmit` учитывает только фото с `processing_state='processed'`.
- В витрину отдаём `cover` + gallery через **derived** (`thumb`, `card`, `watermarked`) по **signed URL** (TTL **10 минут**).

---

## 6) HTTP API (owner side)

### 6.1 CRUD черновиков

```
GET    /v1/me/profiles                          → ProfileSummary[]
POST   /v1/me/profiles                          → CreateProfileDTO  → ProfileDTO
PATCH  /v1/me/profiles/:id                      → UpdateProfileDTO  → ProfileDTO (только draft|needs_fix)
```

### 6.2 Submit

```
POST /v1/me/profiles/:id/submit                 → 202
```

Сервер проверяет `isReadyToSubmit`:

- если ок → `status='submitted'` → создаёт задачу модерации → `pending_moderation` → emit `profile.submitted`;
- если нет → `400 { reasons: [...] }`.

### 6.3 Прайсы и услуги

```
PUT  /v1/me/profiles/:id/prices                 → PriceDTO[] (полная синхронизация)
PUT  /v1/me/profiles/:id/services               → { serviceIds:number[], custom?: string[] } → 204
```

### 6.4 Медиа (см. ADR‑004)

```
POST   /v1/me/profiles/:id/photos/upload-url
POST   /v1/me/profiles/:id/photos/confirm
PATCH  /v1/me/profiles/:id/photos/:photoId
DELETE /v1/me/profiles/:id/photos/:photoId
```

### 6.5 Управление видимостью

```
POST /v1/me/profiles/:id/archive    → 204   (для published|needs_fix|rejected)
POST /v1/me/profiles/:id/unarchive  → 204   (возврат в draft|publishable по правилам)
```

---

## 7) HTTP API (public vitrine)

### 7.1 Список

```
GET /v1/profiles?category=<code>&q=<text>&cursor=<c>&limit=<n>&sort=published_at|price
```

**Фильтры/сортировки:**

- `status='published' AND is_visible=true`;
- `category_id` (индекс);
- поиск по `nickname/title` — ILIKE prefix (MVP);
- сортировки: по `published_at desc` (дефолт) или по минимальной дневной цене `incall` (через LATERAL).

**Ответ:**

```json
{
  "data": [
    {"profileId":"123","nickname":"…","category":"…","coverUrl":"signed-https://…","minPrice":10000,"currency":"RUB"}
  ],
  "nextCursor": "…"
}
```

### 7.2 Детальная карточка

```
GET /v1/profiles/:id
```

Содержит: общие поля анкеты; выбранные услуги (без внутренних кодов модерации); прайсы (матрица, без внутренних ID); `coverUrl` и галерея `thumbUrl[]`, `cardUrl[]` — только **derived** с watermark.

**Кэширование:** публичные ответы кэшируются CDN/HTTP 30–60 секунд; инвалидация — событием `profile.published|archived` (через purge endpoint/ключ).

---

## 8) Консистентность публикации (связь с ADR‑007)

- Переход `publishable → published` происходит **только** по событию `publication.order.paid` от Billing.
- В `profiles.publishFromOrder()` в **одной транзакции**:
  - проверка состояния;
  - установка `status='published'`, `published_at=now()`;
  - запись `expires_at` из заказа (если хранится в профиле);
  - emit `profile.published`.
- Снятие с публикации: по истечению срока (`publication.expire`) → `status='archived'`, `is_visible=false`, emit `profile.archived`.

---

## 9) Индексы и производительность

- `profiles(category_id, status, is_visible)` — витрина.
- `profiles(user_id, status)` — кабинет.
- `profile_photos(profile_id) WHERE is_cover=true` — обложка.
- `profile_prices(profile_id, time_band, visit_type, unit)` — прайсы.
- (опц.) материализованное представление `v_profiles_min_price` для быстрого сортирования по минимальной цене; обновление триггером на `profile_prices`.

---

## 10) Рейт‑лимиты и защита

- `POST /me/profiles` — 10/день/пользователь.
- `PATCH /me/profiles/:id` — 200/час/пользователь.
- `submit` — 3/24h/профиль.
- `upload-url` — 60/час/пользователь; `confirm` — 120/час/пользователь (см. ADR‑004).
- Проверка владения профилем на всех приватных ручках.
- В ответах не светим внутренние ID медиа и лишние поля.

---

## 11) Ошибки (единый формат)

- `profiles.not_found` — профиль не найден/не принадлежит пользователю.
- `profiles.invalid_state` — запрещённый переход статуса.
- `profiles.not_ready_to_submit` — `{ reasons: [...] }`.
- `profiles.limits_exceeded` — превышены лимиты фото/услуг/прайсов.
- `profiles.validation_failed` — детальный список полей.

---

## 12) Псевдокод ключевых операций

### 12.1 Submit

```ts
async function submitProfile(profileId: string, userId: string) {
  const p = await repo.getForUpdate(profileId, userId);
  if (!['draft','needs_fix'].includes(p.status)) throw Err('profiles.invalid_state');
  const ready = await this.isReadyToSubmit(profileId);
  if (!ready.ok) throw Err('profiles.not_ready_to_submit', { reasons: ready.reasons });
  await repo.updateStatus(profileId, 'submitted');               // 1
  await moderation.createTask({ profileId, kind: 'profile_full' });// 2
  await repo.updateStatus(profileId, 'pending_moderation');       // 3
  await bus.emit('profile.submitted', { profileId, userId });     // 4
}
```

### 12.2 Публикация по оплаченному заказу

```ts
async function publishFromOrder(profileId: string, orderId: string, startsAt: Date, expiresAt: Date) {
  await tx.run(async db => {
    const p = await db.profiles.getForUpdate(profileId);
    if (!['publishable','published'].includes(p.status)) throw Err('profiles.invalid_state');
    await db.profiles.setPublished(profileId, { startsAt, expiresAt });
    await bus.emit('profile.published', { profileId, orderId, startsAt, expiresAt });
  });
}
```

---

## 13) DoD (Definition of Done)

- Реализованы ручки кабинета: CRUD draft, submit, прайсы/услуги, медиа (см. ADR‑004).
- Триггер‑гард статусов включён; недопустимые переходы — `4xx`.
- `isReadyToSubmit` возвращает детальные причины; покрыт тестами.
- Витрина: список и деталь, только derived images, пагинация cursor‑based.
- Индексы под витрину/кабинет/прайсы созданы; (опц.) матвью по мин.цене.
- Интеграционные тесты: `draft→submit→pending→(approved→publishable)→pay→published`; `needs_fix`; `rejected`.
- Метрики: время до `publishable`, конверсия `submit→publishable/published`.

---

**Резюме:**\
ADR‑006 фиксирует все аспекты домена `profiles`: статусы и проверки, прайсы и услуги, медиа‑связи, публичную витрину и API.

