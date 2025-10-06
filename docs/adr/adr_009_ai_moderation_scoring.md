# ADR-009 — AI Moderation & Security (Telegram-only)

---

## 1. Решение (Summary)

**Единственная роль:** `user`.\
Нет классических `admin`-ролей, JWT или админ-панелей. Все модерационные и привилегированные действия выполняются через Telegram и CLI.

- **Аутентификация:** passwordless (email / Telegram), серверные сессии в HttpOnly cookie `sid` (см. ADR-003).
- **Модерация:** через Telegram-бота, доступен только whitelisted `telegram_user_id`.
- **Ops-доступ:** через CLI или внутренние ручки с static bearer-токеном + IP allowlist.
- **Audit log:** фиксирует все действия операторов, модераторов и AI-агентов.

---

## 2. Telegram-модерация (замена админ-панели)

### 2.1 Таблица модераторов

Переименовываем `auth.admins` → `auth.moderators` (структура идентична):

| Поле                      | Тип                   | Комментарий              |
| ------------------------- | --------------------- | ------------------------ |
| id                        | bigint, PK            | Уникальный идентификатор |
| telegram\_user\_id        | bigint, UNIQUE        | Telegram ID модератора   |
| display\_name             | text                  | Отображаемое имя         |
| enabled                   | boolean, default true | Активен ли модератор     |
| created\_at / updated\_at | timestamptz           | Системные поля           |

**Назначение:** единственный источник прав на привилегированные действия.

### 2.2 TelegramModeratorGuard

```ts
@Injectable()
export class TelegramModeratorGuard implements CanActivate {
  constructor(private mods: ModeratorsRepo, private cfg: ConfigService) {}
  async canActivate(ctx: ExecutionContext) {
    const req = ctx.switchToHttp().getRequest();
    // Проверка: запрос от Telegram
    const tgUserId = req.body?.message?.from?.id ?? req.body?.callback_query?.from?.id;
    if (!tgUserId) return false;
    const isAllowed = await this.mods.isEnabled(tgUserId);
    return isAllowed;
  }
}
```

Применяется ко всем ручкам Telegram-бота:

```ts
@UseGuards(TelegramModeratorGuard)
@Post('/bot/webhook')
handleTelegramUpdate(...) { ... }
```

### 2.3 Команды бота

- `/vote approve|needs_fix|reject` — голос AI/модератора по задаче.
- `/decision approve|needs_fix|reject` — финальное решение.
- `/task cancel <id> <reason>` — отмена задачи.
- `/order resettle <invoiceId>` — повторная обработка инвойса.
- `/requeue <queue> <jobId>` — вернуть задачу в очередь.

Каждое действие записывается в `auth.audit_log` с `actor_type='telegram'`, `actor_telegram_user_id`, `reason`, `ref_type`, `ref_id`.

---

## 3. Пользователи и сессии

- Сессии: `sid` (opaque), TTL 30 дней, rolling refresh.
- Защита от CSRF: double-submit cookie + Origin header.
- Rate-limits и ограничения API без изменений.
- Нет `refresh_cookie`, `admin_JWT`, `JWKS`.

---

## 4. Внутренние / ops-ручки

Для внутренних операций (например, requeue DLQ, manual resettle):

- Static bearer-token (`Authorization: Bearer <token>`), хранится в Secret Manager.
- IP allowlist (VPN/office only).
- Либо CLI без HTTP: команда `ops:requeue`, `ops:resettle`, `ops:adjust`.

---

## 5. Audit log (главный источник истины)

**Формат:**

| Поле                      | Тип         | Комментарий                                                                   |
| ------------------------- | ----------- | ----------------------------------------------------------------------------- |
| id                        | bigint, PK  |                                                                               |
| actor\_type               | text        | `telegram` / `cli` / `ai` / `system`                                          |
| actor\_telegram\_user\_id | bigint      | nullable                                                                      |
| action                    | text        | тип действия: `moderation.decision`, `ops.job.requeue`, `billing.adjust`, ... |
| ref\_type                 | text        | ссылка на сущность (profile, task, order, invoice)                            |
| ref\_id                   | bigint      | идентификатор сущности                                                        |
| reason                    | text        | причина действия                                                              |
| created\_at               | timestamptz | время фиксации                                                                |

**События:**

```
moderation.decision.applied { tgUserId, taskId, profileId, decision }
ops.job.requeue { jobId, queue }
ops.job.cancel { jobId }
billing.adjust { userId, deltaMinor, currency }
```

---

## 6. Безопасность

- **Поверхность админа:** только Telegram webhook и CLI.
- **Telegram webhook:** IP allowlist Telegram, секрет в пути `/bot/<token>/webhook`, проверка подписи, rate-limit 1 msg/sec/user.
- **CLI:** только в VPN, с использованием Secret Manager для токенов.
- **Все действия аудируются.**
- **AI-процессы (ADR-010)** действуют только в пределах своих токенов, без человекоподобных прав.

---

## 7. AI-модерация и связка с ADR-010

- AI-модели (OpenAI / локальные) формируют первичные предложения решений.
- Telegram-модераторы подтверждают / отклоняют.
- Итоговое решение фиксируется событием `moderation.decision.applied`.
- AI не имеет write-доступа в прод-таблицы: все изменения идут через событие или фоновую задачу.

---

## 8. Удалённые админ-интерфейсы

- Нет `/v1/admin/*` ручек, нет админ-фронта.
- Все потенциально опасные операции доступны либо через Telegram-бота, либо CLI.
- Исключение: health/metrics endpoints (см. ADR-008).

---

## 9. DoD (Definition of Done)

- JWT и admin-cookie полностью удалены.
- `auth.moderators` создана и наполняется вручную (через миграцию или seed).
- TelegramModeratorGuard внедрён на все ручки бота.
- Все действия пишутся в `auth.audit_log`.
- Ops CLI работает под VPN.
- Нет публичных `/v1/admin` или `RoleGuard('admin')`.

---

**Резюме:**\
ADR-009 определяет финальную модель безопасности и модерации Aboba — без веб-админки и JWT, с Telegram-first управлением, централизованным аудитом и безопасной изоляцией AI-агентов.

