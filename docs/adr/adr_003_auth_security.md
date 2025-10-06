# ADR-003 — Auth & Security

---

## 1. Цель

Определить архитектуру авторизации и безопасности в Aboba, включая passwordless-аутентификацию, управление сессиями, CSRF/CORS-политику, аудит, лимиты и защиту от злоупотреблений. Все правила основаны на оригинальном ADR-003 и синхронизированы с DB Spec.

---

## 2. Архитектурные принципы

- **Модель входа:** только passwordless — Email OTP/магик-линк и Telegram OTP через `@VerificationCodes`.
- **Сессии:** серверные, opaque-токен в HttpOnly cookie; запись в `auth.sessions`.
- **CSRF:** double-submit токен + Origin/Referer-проверка.
- **Rate limits:** Redis; анти-брутфорс и анти-энумерация.
- **Аудит:** все важные события пишутся в `auth.audit_log`.
- **PII и безопасность:** коды и токены хранятся только в хэшах.

---

## 3. Схема данных (модуль `auth`)

| Таблица                | Назначение                                                                    |
| ---------------------- | ----------------------------------------------------------------------------- |
| `auth.users`           | основная учётка (email nullable, Telegram — через `auth.auth_identities`)     |
| `auth.auth_identities` | { provider:'email'\|'telegram', provider\_uid }                               |
| `auth.auth_challenges` | одноразовые вызовы (OTP/магик-линк), `expires_at`, `used_at`, `purpose`       |
| `auth.sessions`        | активные сессии (`issued_at`, `expires_at`, `revoked_at`, `ip`, `user_agent`) |
| `auth.rate_limits`     | счётчики (`subject × key`)                                                    |
| `auth.audit_log`       | insert-only аудит                                                             |

**TTL:**

- `auth_challenges` — 10 минут.
- `auth.sessions` — 30 дней, с rolling-продлением.

---

## 4. Потоки (flows)

### 4.1 Email OTP / Magic-link

**POST /v1/auth/email/request → 204**

- нормализуем email;
- создаём challenge (`purpose='email_verify'|'login'`, `channel='email'`);
- отправляем письмо с кодом (6–8 цифр) или магик-линком.

**POST /v1/auth/email/verify → SessionDTO**

- проверяем challenge (не истёк, не использован);
- создаём/находим пользователя;
- создаём сессию, помечаем `used_at=now()`;
- возвращаем `{userId, csrfToken}`.

**GET /v1/auth/callback?token=… → redirect на фронт**

- валидация токена по хэшу, создание сессии, редирект.

### 4.2 Telegram OTP

**POST /v1/auth/telegram/verify { tgCode } → SessionDTO**

- backend валидирует код у Telegram;
- создаёт/находит пользователя;
- создаёт сессию;
- пишет `audit: signup` + `login.success`.

---

## 5. Сессии (opaque + rotation)

- При логине генерируется `session_token` (256 бит), в БД хранится хэш (`argon2id/sha512`).
- В cookie кладётся сырой токен: `sid=<opaque>; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`.
- Проверка: ищем `token_hash`, сверяем `expires_at`, `revoked_at IS NULL`.
- При успехе — rolling-продление `expires_at` и обновление cookie.
- Logout (`DELETE /v1/auth/session`) → `revoked_at=now()` и гашение cookie.

---

## 6. CSRF и CORS

- **CORS:** preflight ограничен списком доверенных Origins.
- **CSRF:** для POST/PATCH/DELETE:
  - `csrf=<random>` cookie (не HttpOnly) + заголовок `X-CSRF-Token`;
  - Origin/Referer-проверка.

---

## 7. Безопасность и антизлоупотребление

- **Ответы без утечек:** всегда 204 (в том числе при rate limit или неизвестном email).
- **Хранение:** только хэши кодов/токенов; сырые значения живут только в письме или куке.
- **Логи:** без PII, только маски/email-hash.
- **Rate caps:**
  - `/auth/email/request`: 5/email/ч, 20/IP/ч.
  - `/auth/email/verify`: 10/email/ч, 30/IP/ч.
  - `/auth/telegram/verify`: 10/TG/ч, 30/IP/ч.
- **Block & cooldown:** при >N ошибок подряд — блок на 15–30 мин через `auth.rate_limits`.
- **Device binding (опц.):** проверка UA/IP-субсети, мягкое предупреждение или повторная верификация.

---

## 8. API и DTO

### Email

```
POST /v1/auth/email/request → 204
POST /v1/auth/email/verify → { email, code, csrfToken } → { userId, roles, csrfToken }
```

### Telegram

```
POST /v1/auth/telegram/verify → { tgCode, csrfToken } → { userId, roles, csrfToken }
```

### Session

```
GET /v1/auth/session → { userId, roles, expiresAt }
DELETE /v1/auth/session → 204
```

**Ошибки:** `{ code, message, details, traceId }`

---

## 9. Аудит

Логируются события:

```
signup (user_id, method)
login.success (user_id, identity)
login.failed (subject masked)
challenge.issued (channel, purpose)
session.revoked (user_id, session_id)
rate_limit.hit (subject, key)
```

Payload минимальный, без PII; IP и User-Agent допускаются.

---

## 10. Псевдо-реализация (упрощённо)

```ts
async function verifyEmailCode({ email, code, ip, ua }) {
  await rateLimit.hit(`email:${email}`, 'email_verify', 10, '1h');
  const ch = await challenges.findValid({ email, purpose: 'email_verify', code });
  if (!ch) throw new AuthError('auth.invalid_code');
  const user = await users.upsertByEmail(email);
  await identities.ensure(user.id, { provider: 'email', provider_uid: normalize(email) });
  const session = await sessions.issue(user.id, { ip, ua });
  await challenges.markUsed(ch.id);
  await audit.log(user.id, 'login.success', { identity: 'email' });
  return session;
}
```

---

## 11. Definition of Done (DoD)

- Реализованы ручки `/auth/email/request`, `/auth/email/verify`, `/auth/telegram/verify`, `/auth/session (GET/DELETE)`.
- Cookies `sid` + `csrf` настроены; double-submit + Origin-check включены.
- Rate limits на Redis.
- Хранение challenge/session по хэшам токенов.
- Rolling-продление сессий и rotation при логине.
- Аудит-события пишутся; PII не утекает.
- Интеграционные тесты: email/telegram login, истёкший код, rate-limit, logout.

---

**Резюме:**\
ADR-003 определяет полную модель passwordless-аутентификации, управление сессиями и политику безопасности в Aboba.\
Система исключает утечку PII, устойчиво защищена от брутфорса и поддерживает безопасную интеграцию с Telegram OTP.

