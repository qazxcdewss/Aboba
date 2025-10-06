# ADR-007 — Billing, Publication Orders, Transactions

---

## 1. Решение (Summary)

- **Баланс-центричная модель:** единственный источник правды — `billing_transactions`.\
  Балансы рассчитываются как агрегат подтверждённых транзакций и хранятся в `billing_balances`.
- **Пополнение:** через ончейн-инвойсы (`billing_invoices`). При подтверждении сети создаётся `deposit`‑транзакция и обновляется баланс.
- **Списание:** операция `charge(out)` с уникальным `idempotency_key`.\
  Оплата публикации: `charge` → уменьшение баланса → `order.paid` → `profile.published`.
- **Публикационные заказы:** `billing_profile_publication_orders` фиксируют цену, валюту, период; состояние `pending|paid|expired|canceled`.
- **Идемпотентность:** на всех уровнях (транзакции, заказы, события) через `UNIQUE idempotency_key` и атомарные транзакции.

---

## 2. Данные и владение (модуль `billing`)

| Таблица                              | Назначение                                                           |
| ------------------------------------ | -------------------------------------------------------------------- |
| `billing_invoices`                   | Ончейн-инвойсы для пополнения (адрес, мемо, точная сумма, TTL)       |
| `billing_onchain_txs`                | Сырые данные сетей (tx\_hash, адрес, мемо, подтверждения)            |
| `billing_transactions`               | Все финансовые движения (deposit, charge, adjust) с идемпотентностью |
| `billing_balances`                   | Баланс пользователя по валютам; агрегирует confirmed‑транзакции      |
| `billing_profile_publication_orders` | Заказы на публикацию профиля (цена, период, состояние)               |

**Ключевые поля:**

- `idempotency_key UNIQUE` во всех денежных таблицах.
- `billing_balances (user_id, currency)` — PK.
- `billing_onchain_txs (chain, tx_hash UNIQUE)` — предотвращает дубли.

**Индексы:**

- `transactions(user_id, currency)`
- `orders(profile_id, state, expires_at)`
- `invoices(user_id, state, expires_at)`

---

## 3. События и очереди

**Emit:**

```
billing.deposit.confirmed { userId, currency, amountMinor, invoiceId, idempotencyKey }
billing.charge.confirmed { userId, currency, amountMinor, refType:'publication_order', refId, idempotencyKey }
publication.order.paid   { orderId, profileId, startsAt, expiresAt }
publication.order.expired { orderId, profileId }
```

**BullMQ очереди:**

- `billing.watch.<chain>` — слушает сеть, складывает `billing_onchain_txs`.
- `billing.settle` — связывает `onchain_tx → invoice → deposit` (идемпотентно).
- `publication.expire` / `publication.remind` — истечение и уведомления по заказам.

**Политика:**

- `maxAttempts=5`, экспоненциальный backoff, DLQ c ручным requeue.

---

## 4. Денежные операции

### 4.1 Deposit (settlement)

Watcher сети сохраняет `billing_onchain_txs` (`chain+tx_hash` уникальны).\
После подтверждений создаётся транзакция и обновляется баланс.

**Псевдокод:**

```ts
async function settleDeposit({ invoiceId, txHash, currency, amountMinor, idemKey }) {
  await tx.run(async db => {
    const inv = await db.invoices.getForUpdate(invoiceId);
    if (!inv || inv.state === 'confirmed') return; // idem
    const inserted = await db.transactions.insertIfAbsent({
      user_id: inv.user_id,
      tx_kind: 'deposit', direction: 'in', money_source: 'onchain',
      currency, amount_minor: amountMinor, status: 'confirmed', idempotency_key: idemKey,
      ref_type: 'billing_invoices', ref_id: invoiceId
    });
    if (!inserted) return; // уже обработано
    await db.balances.increment(inv.user_id, currency, amountMinor);
    await db.invoices.markConfirmed(invoiceId);
    await bus.emit('billing.deposit.confirmed', { userId: inv.user_id, currency, amountMinor, invoiceId, idempotencyKey: idemKey });
  });
}
```

### 4.2 Charge (оплата заказа публикации)

```ts
async function payPublicationOrder(userId, orderId, idemKey) {
  await tx.run(async db => {
    const ord = await db.orders.getForUpdate(orderId, userId);
    if (!ord || ord.state !== 'pending') throw Err('billing.order_invalid_state');
    const bal = await db.balances.getForUpdate(userId, ord.currency);
    if (bal.amount_minor < ord.price_minor) throw Err('billing.insufficient_funds');
    const inserted = await db.transactions.insertIfAbsent({
      user_id: userId, tx_kind: 'charge', direction: 'out', money_source: 'onchain',
      currency: ord.currency, amount_minor: ord.price_minor, status: 'confirmed', idempotency_key: idemKey,
      ref_type: 'publication_order', ref_id: orderId
    });
    if (!inserted) return;
    await db.balances.decrement(userId, ord.currency, ord.price_minor);
    const startsAt = new Date();
    const expiresAt = new Date(startsAt.getTime() + ord.period_days * 864e5);
    await db.orders.markPaid(orderId, { startsAt, expiresAt });
    await bus.emit('billing.charge.confirmed', { userId, currency: ord.currency, amountMinor: ord.price_minor, refType:'publication_order', refId: orderId, idempotencyKey: idemKey });
    await bus.emit('publication.order.paid', { orderId, profileId: ord.profile_id, startsAt, expiresAt });
  });
}
```

---

## 5. Цены, валюты и комиссии

- `currency` хранится как ISO‑код (например, `RUB`, `USDT`).
- `amount_minor` — целые единицы (например, копейки/центавос).
- Конвертации MVP не делает — курс задаётся вручную на уровне `invoice`.
- Комиссия (`fee_minor`) может быть добавлена позже, но сейчас = 0.

---

## 6. HTTP API

### 6.1 Инвойсы

```
POST /v1/billing/invoices
→ { asset:"XRP" }
← InvoiceDTO { invoiceId, chain, asset, address, memo, exactAmountAsset, expiresAt, state }

GET /v1/billing/invoices/:id → InvoiceDTO
```

### 6.2 Баланс и транзакции

```
GET /v1/billing/balance → [{ currency, amountMinor }]
GET /v1/billing/transactions?cursor&limit → [{ txKind, amountMinor, status, createdAt }]
```

### 6.3 Публикационные заказы

```
POST /v1/billing/publication-orders
→ { profileId, periodDays }
← PublicationOrderDTO { orderId, priceMinor, currency, periodDays, state }

POST /v1/billing/publication-orders/:id/pay
→ { idempotencyKey }
← 202 Accepted
```

**Ошибки:**

- `billing.insufficient_funds`
- `billing.order_invalid_state`
- `billing.invoice_expired`
- `billing.rate_limited`

---

## 7. Watchers (слежение за ончейн‑транзакциями)

- MVP‑цепочка: **XRP** (уникальные `address + memo`, мгновенные подтверждения).
- Возможные расширения: TRON/USDT, BTC, ETH.
- Watcher слушает сеть и вставляет `billing_onchain_txs`; после нужных подтверждений ставит задачу `billing.settle`.
- Идемпотентность: ключ `deposit:<chain>:<tx_hash>`.

---

## 8. Безопасность и комплаенс

- Custody‑free: проект не хранит средства, а только отражает баланс.
- Данные on‑chain публичны, без PII.
- Все операции через `idempotency_key` предотвращают двойной учёт.
- Финансовые события дублируются в `auth.audit_log`.
- KYC/AML вне MVP‑объёма, может быть добавлен как модуль.

---

## 9. Метрики и алерты

| Метрика                           | Значение                           |
| --------------------------------- | ---------------------------------- |
| `billing_balance_total{currency}` | Сумма всех балансов (sanity‑check) |
| `billing_tx_count{kind}`          | Количество транзакций              |
| `billing_queue_watch_lag{chain}`  | Отставание по блокам               |
| `billing_settle_duration_seconds` | Время от first\_seen до confirm    |

**Алерты:**

- Рост `failed/reversed` транзакций.
- Несоответствие: ∑confirmed deposits ≠ Δбалансов (нарушение инварианта).

---

## 10. DoD (Definition of Done)

- Все таблицы и индексы созданы, `idempotency_key` уникален.
- Очереди `billing.watch.<chain>` и `billing.settle` работают, DLQ подключён.
- Реализованы API: инвойсы, баланс, заказы, оплата.
- Интеграционные тесты: повторные депозиты и оплаты — идемпотентны.
- Профиль публикуется по событию `publication.order.paid` (см. ADR‑006).
- Метрики и аудит финансов включены.

---

**Резюме:**\
ADR‑007 описывает полный биллинговый модуль Aboba: депозиты, транзакции, балансы и оплату публикаций. Модель гарантирует идемпотентность, консистентность и безопасную интеграцию с профилями и ончейн‑вочерами.

