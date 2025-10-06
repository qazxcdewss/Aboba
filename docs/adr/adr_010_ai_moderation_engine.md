# ADR-010 — AI Moderation & Risk Scoring (Manual-only Mode)

---

## 1. Решение (Summary)

ИИ-модерация используется только для вычисления **`ai_score`**, формирования **`ai_payload`** и **приоритизации** задач в Telegram-модерации.  
Автоматическое принятие решений **запрещено** — все решения финализируются вручную через Telegram (см. ADR-009).

**Ключевые цели:**
- Анализ фото и листков через AWS Rekognition + Textract.
- Расчёт `ai_score`, приоритета (`priority`) и флагов риска.
- Отправка полной карточки в Telegram с ИИ-сводкой.
- Сохранение метаданных в `moderation_tasks` и `moderation_decisions`.

---

## 2. Архитектура / Data Flow

```
Upload → media.worker
   ↳ AWS Rekognition: DetectFaces + ModerationLabels
   ↳ Rekognition Collections (IndexFaces / CompareFaces)
   ↳ AWS Textract: OCR (листок)
   ↳ compute ai_score, ai_payload, priority
   ↳ save → moderation_tasks
   ↳ emit moderation.post_to_tg
Telegram bot → карточка с ИИ-сводкой → решение модератора
   ↳ moderation_decisions (ai_snapshot)
```

---

## 3. База данных

### Таблица `moderation_tasks`
| Поле | Тип | Комментарий |
|------|-----|-------------|
| ai_score | NUMERIC(6,3) | итоговый риск-скор [0,1] |
| ai_payload | JSONB | исходный результат AI анализа (NSFW, лица, OCR) |
| priority | SMALLINT DEFAULT 100 | приоритет модерации (чем меньше — тем выше приоритет) |

### Таблица `moderation_decisions`
| Поле | Тип | Комментарий |
|------|-----|-------------|
| ai_snapshot | JSONB | снэпшот ai_payload на момент решения |

---

## 4. Провайдеры
- **AWS Rekognition:** DetectFaces, ModerationLabels, IndexFaces, CompareFaces.
- **AWS Textract:** OCR (поиск ABOBA ID, проверка подлинности листка).
- Все креденшелы хранятся в AWS Secrets Manager.

---

## 5. Face Detect & Quality

**Валидный портрет:**
```
Face.Confidence ≥ 0.9
area ≥ 0.06
|Yaw| ≤ 25°, |Pitch| ≤ 15°, |Roll| ≤ 15°
Sharpness ≥ 40
Brightness ∈ [20, 95]
```

**Формула качества:**
```
face_quality = (0.35 * frontal + 0.30 * sharp + 0.25 * area + 0.10 * light) × penalty
```

Выбираем топ-3–5 фото по `face_quality`.

---

## 6. Consistency (один человек?)

- Режим `AI_FACE_MODE=rekognition`.
- `IndexFaces` → `Collection`.
- `CompareFaces` → similarity.

**Показатели:**
```
coverage = доля фото с similarity ≥ 0.8
cohesion = средняя similarity внутри основного кластера
consistency = 0.6 × coverage + 0.4 × cohesion
```

**Риск:**
```
если coverage < 0.6 или cohesion < 0.55 → consistency_risk = true
```

---

## 7. OCR листка

**Textract → текст → ABOBA ID:**
- Ищем `ABOBA ID\d+`.
- Проверяем контур бумаги, резкость, тени.

**Результат:**
```
text_match: true|false
overlay_suspected: true|false
```

---

## 8. Policy Engine (Manual-only)

- Все задачи попадают в `state='sent_to_tg'`.
- Telegram отображает карточку с полями:
```
#123 • profile:45 • photo
AI:
• Risk 0.18 (Low)
• NSFW: Explicit 0.02 / Suggestive 0.12
• Faces 0.91, 0.88, 0.84
• Consistency 0.76 (cov 0.8 coh 0.7)
• OCR match=YES overlay=NO
• Flags —
Кнопки: Approve / Needs fix / Reject
/details <id> → полный ai_payload
```

---

## 9. Пример ai_payload

```json
{
  "nsfw": {
    "labels": [{"name": "Explicit Nudity", "conf": 0.02}]
  },
  "faces": {
    "top": [{"photoId": 111, "score": 0.91}]
  },
  "consistency": {
    "coverage": 0.8,
    "cohesion": 0.7,
    "score": 0.76,
    "risk": false
  },
  "ocr": {
    "text_match": true,
    "overlay_suspected": false
  },
  "provider": "aws_rekognition",
  "face_mode": "rekognition"
}
```

---

## 10. Метрики

| Метрика | Назначение |
|----------|-------------|
| `ai_moderation_requests_total{provider}` | количество вызовов к AI API |
| `ai_score_distribution_bucket` | гистограмма распределения `ai_score` |
| `ai_policy_priority_total{level}` | счётчик задач по уровням приоритета |

---

## 11. Безопасность

- Используются presigned URL (TTL 10 мин) для передачи медиа.
- Все AI-данные обезличены (без PII).
- Secrets — в AWS Secrets Manager.
- Audit: `system` события (`ai_moderation.request`, `ai_moderation.result`, `ai_moderation.error`).

---

## 12. DoD (Definition of Done)

- AI-интеграция подключена в `media.worker`.
- `ai_score`, `ai_payload` и `priority` сохраняются в БД.
- Все таски проходят через Telegram.
- TG-карточка отображает AI-сводку.
- Решения фиксируются в `moderation_decisions` с `ai_snapshot`.
- Метрики и алерты активны.

---

**Резюме:**  
ADR-010 фиксирует архитектуру и поведение AI-модерации Aboba: анализ фото и листков в AWS Rekognition + Textract, расчёт риска и приоритета, но с ручным подтверждением человеком-модератором через Telegram. Без автопубликаций и без write-доступа AI к прод-данным.

