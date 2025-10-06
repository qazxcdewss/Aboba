# ADR-004 — Media Pipeline (фото/видео, пайплайн, безопасность)

---

## 1) Решение (Summary)

**Хранилище:** S3-совместимое (prod: AWS S3; dev: MinIO). Два бакета:

- `aboba-media-original` — **приватный**, оригиналы; **никогда** не раздаём напрямую.
- `aboba-media-derived` — **приватный**, но раздаём по **presigned URL**, TTL **10 минут**.

**Загрузка:** клиент получает **presigned POST** (multipart/form-data) в `original`, затем вызывает `/confirm` → создаётся запись в БД и ставится задача в очередь.

**Пайплайн:** BullMQ `` / ``:\
*antivirus → exif-strip → normalize/resize(thumb, card) → watermark → hash(sha256, pHash) → NSFW → persist meta → emit \*\*\*\*\*\*\*\*\*\*\*\*\*\***`media.photo.processed`*.

**Безопасность:** EXIF-strip, строгие MIME/size‑лимиты, вирус‑скан, водяной знак, раздача **только derived**.

**Идемпотентность:** ключ по **(profileId, storageKey, sha256)** — повторная обработка не ломает состояние. `is_cover`/порядок меняются транзакционно.

**Ограничения MVP:** фото **3–30 шт.** (≤ **25 MB**/файл, `jpg/png/webp`), видео (≤ **100 MB**) — выключаем флагом `ENABLE_VIDEO=false`.

---

## 2) Структура ключей и варианты (S3 object keys)

**Originals** (не раздаём):

```
aboba-media-original/
  profiles/{profileId}/photos/{photoTempId}/orig
```

**Derived** (раздаём по signed URL):

```
aboba-media-derived/
  profiles/{profileId}/photos/{photoId}/thumb.jpg       # ~256px длинная сторона
  profiles/{profileId}/photos/{photoId}/card.jpg        # ~1024px длинная сторона
  profiles/{profileId}/photos/{photoId}/watermarked.jpg
```

В момент `confirm` ещё нет `photoId` (PK), используем временный `{photoTempId}`; воркер после `INSERT` знает `photoId` и пишет derived с финальным путём.

---

## 3) Контракты HTTP (внешние) — media‑часть

### 3.1 Получить presigned POST для загрузки оригинала

`POST /v1/me/profiles/:profileId/photos/upload-url`

**Req:**

```json
{ "mime": "image/jpeg", "sizeBytes": 1048576 }
```

**Resp:**

```json
{
  "upload": {
    "url": "https://s3.amazonaws.com/aboba-media-original",
    "fields": { "...": "..." },       
    "expiresAt": "2025-10-05T12:34:56Z",
    "key": "profiles/123/photos/tmp_4fX8/orig"
  },
  "constraints": {
    "maxBytes": 26214400,
    "allowedMime": ["image/jpeg","image/png","image/webp"]
  }
}
```

**Правила:** проверяем право владельца на `profileId`, лимит **3–30** фото, генерим короткоживущие поля (TTL ≤ **10 мин**), валидируем MIME/size на бэкенде и в bucket‑policy (`Content-Length-Range`, `Content-Type`).

### 3.2 Подтвердить загрузку (создать запись в БД и запустить обработку)

`POST /v1/me/profiles/:profileId/photos/confirm`

**Req:**

```json
{
  "storageKey": "profiles/123/photos/tmp_4fX8/orig",
  "sha256": "base64/hex",
  "sizeBytes": 1048576,
  "width": 2048,
  "height": 1365
}
```

**Resp (PhotoDTO):**

```json
{
  "photoId": "98765",
  "isCover": true,
  "orderIndex": 1,
  "state": "processing",
  "variants": []
}
```

**Действия:** транзакционно создаём `profile_photos` (`processing_state='pending'`, `virus_scanned=false`, `exif_stripped=false`, `watermark_applied=false`, `nsfw_score=null`, `sha256`); если это первое фото — `isCover=true`, `orderIndex=1`; пушим `media.process_photo` с `{profileId, photoId, storageKey}`.

### 3.3 Управление фото

`PATCH /v1/me/profiles/:profileId/photos/:photoId` → `{ "isCover": true }` или `{ "orderIndex": 5 }`\
Транзакционно: сбросить прежнюю обложку; `orderIndex` уникален в рамках профиля.

`DELETE /v1/me/profiles/:profileId/photos/:photoId` → 204\
Удаляем запись + derived‑объекты; оригинал можно снести async (GDPR/TTL; по умолчанию держим **90 дней**).

Аналоги для видео: `upload-url`, `confirm`, `delete` (если включено).

---

## 4) Очереди и пайплайн обработки

### 4.1 Очередь `media.process_photo`

**Job data:**

```ts
interface ProcessPhotoJob {
  profileId: string;
  photoId: string;
  storageKey: string;            // original
  variants?: Array<'thumb'|'card'|'watermarked'>;
  requestId?: string;
}
```

**Steps (воркер):**

1. **Anti‑virus:** clamd/λ‑AV (fast‑fail).
2. **MIME sniff + re‑encode** (JPEG/WebP) по политике.
3. **EXIF strip** (всегда).
4. **Resize:** `thumb` (\~256px), `card` (\~1024px).
5. **Watermark** на `card` (диагональ/угол, opacity 0.15–0.2).
6. **Hashing:** `sha256` (повторная проверка), `pHash` (анти‑дубликаты).
7. **NSFW** скоринг; сохранить в БД.
8. **Persist:** загрузить derived в `aboba-media-derived/...`, обновить `profile_photos` флаги (`virus_scanned=true`, `exif_stripped=true`, `watermark_applied=true`, `processing_state='processed'`, `nsfw_score=…`, `processed_at=now()`).
9. **Emit** `media.photo.processed`.

**Идемпотентность:** в начале воркер проверяет `profile_photos.processing_state`:\
– если `processed` и есть derived → noop;\
– если `failed` → requeue вручную.\
**Ошибки:** при фатальной ошибке → `processing_state='failed'`, `processing_error='...'`, запись в DLQ, алерт.

---

## 5) Модель данных (акценты `profile_photos`)

- `profile_id (FK)`, **ровно одна** обложка `is_cover=true` (partial UNIQUE).
- `order_index` уникален в профиле.
- `storage_key (UNIQUE)`, `sha256`, `phash`, `mime`, `size_bytes`, `width`, `height`.
- `virus_scanned bool`, `exif_stripped bool`, `watermark_applied bool`.
- `nsfw_score numeric(4,3) NULL`.
- `processing_state ENUM('pending','processing','processed','failed')`, `processing_error TEXT`.
- `uploaded_at`, `processed_at`, `created_at`, `updated_at`.

**Индексы и ограничения:**

- `UNIQUE (profile_id) WHERE is_cover = true` — единственная обложка.
- `UNIQUE (profile_id, order_index)` — порядок без дыр.
- `UNIQUE (profile_id, sha256)` — анти‑дубли внутри профиля.
- `INDEX (processing_state)`; `INDEX (profile_id, order_index)`.

---

## 6) Безопасность и анти‑абьюз

- **Bucket policy:** запрет публичного доступа; `Content-Length-Range`; разрешён только **POST** с корректным `Content-Type`; префиксы — на уровне приложения (валидация `profileId`).
- **Signed URL only:** выдаём **только** на derived; TTL ≤ **10 минут**; (опц.) одноразовый URL с подписью запроса.
- **Watermark:** на всех публичных **крупных** вариантах (`card`; по желанию — `thumb`).
- **Rate‑limits:** `photos/upload-url` — 60/ч/пользователь; `photos/confirm` — 120/ч/пользователь.
- **Антивирус:** обязательно **до** любых derived.
- **EXIF:** всегда strip (включая GPS/датчики).
- **Secrets:** ключи S3 только на сервере; клиент получает только presigned‑поля.

---

## 7) Публичные DTO и URL‑раздача

**PhotoDTO (приватный, владелец):**

```json
{
  "photoId": "98765",
  "isCover": true,
  "orderIndex": 1,
  "state": "processed",
  "variants": {
    "thumbUrl": "https://...signed...",
    "cardUrl": "https://...signed...",
    "watermarkedUrl": "https://...signed..."
  },
  "nsfwScore": 0.12
}
```

**VitrineItem (публичный):**

```json
{
  "profileId": "123",
  "nickname": "…",
  "coverUrl": "https://...signed...",
  "prices": { "day": { "incall": "...", "outcall": "..." } }
}
```

---

## 8) Пример обработчика (псевдокод NestJS воркера)

```ts
@Processor('media.process_photo')
export class ProcessPhotoConsumer {
  constructor(
    private readonly s3: S3Service,
    private readonly repo: ProfilePhotosRepo,
    private readonly img: ImageOpsService,   // antivirus, exifStrip, resize, watermark
    private readonly bus: EventBus,
  ) {}

  @Process()
  async handle(job: Job<ProcessPhotoJob>) {
    const { profileId, photoId, storageKey } = job.data;
    const photo = await this.repo.findByIdForUpdate(photoId);
    if (!photo || photo.processing_state === 'processed') return;
    try {
      await this.img.antivirus(storageKey);                     // 1
      const buf  = await this.s3.getObjectOriginal(storageKey);
      const raw  = await this.img.normalizeAndStripExif(buf);   // 2-3
      const thumb = await this.img.resize(raw, { max: 256 });
      const card  = await this.img.resize(raw, { max: 1024 });
      const wm    = await this.img.watermark(card);             // 4-5
      const sha256 = await this.img.sha256(raw);                // 6
      const pHash  = await this.img.pHash(raw);
      const nsfw   = await this.img.nsfw(card);                 // 7
      await this.s3.putDerived(profileId, photoId, 'thumb.jpg', thumb);
      await this.s3.putDerived(profileId, photoId, 'card.jpg',  card);
      await this.s3.putDerived(profileId, photoId, 'watermarked.jpg', wm);
      await this.repo.markProcessed(photoId, {
        sha256, pHash, nsfwScore: nsfw.score,
        virusScanned: true, exifStripped: true, watermarkApplied: true,
      });                                                       // 8
      await this.bus.emit('media.photo.processed', {
        profileId, photoId, nsfwScore: nsfw.score, sha256,
      });                                                       // 9
    } catch (err) {
      await this.repo.markFailed(photoId, String(err));
      throw err; // retry / DLQ
    }
  }
}
```

---

## 9) DoD (Definition of Done)

- Реализованы ручки: `upload-url`, `confirm`, `patch (isCover/orderIndex)`, `delete`.
- S3 бакеты, policy, CORS и lifecycle (TTL originals **90 дней**) настроены.
- Воркеры BullMQ: очередь `media.process_photo`, ретраи, DLQ, логи.
- Антивирус работает (clamd/λ), EXIF‑strip включён, watermark применяется.
- Выдача только **derived** по signed URL; TTL ≤ **10 минут**.
- Частичные уникальности/индексы в `profile_photos` активны (обложка, порядок, sha256).
- Интеграционные тесты: happy‑path загрузка→confirm→processed; отказ (вирус/NSFW>threshold) → `failed`.
- Метрики: время обработки фото, процент ошибок, длина очереди.

---

**Резюме:**\
ADR‑004 фиксирует полный медиапайплайн Aboba: безопасная загрузка, обработка фото/видео, derived‑раздача, защита и идемпотентность.&#x20;

