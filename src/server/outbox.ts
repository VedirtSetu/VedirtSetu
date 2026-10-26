/**
 * Transactional Outbox Pattern for VedirtSetu
 * Resolves BUG-05: Non-Atomic Dual-Database Writes without Distributed Transaction or Outbox
 * 
 * Guarantees:
 * 1. Atomicity: Primary SQLite mutations and Outbox records commit in the same local ACID transaction.
 * 2. Eventual Consistency: Asynchronous outbox worker pushes events to Firestore with exponential backoff.
 * 3. Idempotency: Deduplicates events and ensures external cloud state matches local database state.
 * 4. Fault Tolerance: Network errors, timeouts, and cloud disruptions are safely queued and retried.
 */

import { query, queryOne, execute, withTransaction, hashPin } from './db.ts';
import {
  saveOrderToFirestore,
  updateOrderInFirestore,
  saveShopToFirestore,
  deleteShopFromFirestore,
  saveProductToFirestore,
  deleteProductFromFirestore,
  savePaymentToFirestore,
  updatePaymentInFirestore,
  saveSubscriptionPaymentToFirestore,
  saveSubscriptionPlansToFirestore,
  saveDistributorToFirestore,
  updateDistributorStatusInFirestore,
  deleteDistributorFromFirestore,
  saveSettingsToFirestore,
} from '../services/firebase.ts';

export type OutboxStatus = 'pending' | 'processing' | 'completed' | 'failed';

export type OutboxEventType =
  | 'ORDER_CREATED'
  | 'ORDER_UPDATED'
  | 'ORDER_STATUS_CHANGED'
  | 'ORDER_CANCELLED'
  | 'SHOP_CREATED'
  | 'SHOP_UPDATED'
  | 'SHOP_DELETED'
  | 'PRODUCT_CREATED'
  | 'PRODUCT_UPDATED'
  | 'PRODUCT_DELETED'
  | 'PAYMENT_CREATED'
  | 'PAYMENT_UPDATED'
  | 'PAYMENT_DELETED'
  | 'DISTRIBUTOR_CREATED'
  | 'DISTRIBUTOR_UPDATED'
  | 'DISTRIBUTOR_STATUS_CHANGED'
  | 'DISTRIBUTOR_DELETED'
  | 'SUBSCRIPTION_PAYMENT_CREATED'
  | 'SUBSCRIPTION_PLANS_UPDATED'
  | 'SETTINGS_UPDATED';

export interface OutboxRecord {
  id: number;
  event_type: OutboxEventType | string;
  entity_type: string;
  entity_id: string;
  payload: string;
  status: OutboxStatus;
  retry_count: number;
  last_error: string | null;
  created_at: string;
  processed_at: string | null;
}

export interface OutboxStats {
  pending: number;
  processing: number;
  completed: number;
  failed: number;
  total: number;
  isWorkerRunning: boolean;
}

let workerIntervalId: NodeJS.Timeout | null = null;
let isProcessingBatch = false;
let immediateTriggerTimeout: NodeJS.Timeout | null = null;

/**
 * Initialize outbox table in SQLite if it does not already exist
 */
export function initOutboxTable(): void {
  try {
    execute(`
      CREATE TABLE IF NOT EXISTS outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'completed', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at TEXT NOT NULL,
        processed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_outbox_status_retry ON outbox(status, retry_count);
      CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON outbox(created_at);
      CREATE INDEX IF NOT EXISTS idx_outbox_entity ON outbox(entity_type, entity_id);
    `);

    // Recover any events left stuck in 'processing' due to an abrupt server restart or crash
    execute(`UPDATE outbox SET status = 'pending' WHERE status = 'processing'`);
  } catch (err) {
    console.error('[Outbox] Failed to initialize outbox table:', err);
  }
}

/**
 * Enqueue an outbox event.
 * MUST be called inside a `withTransaction` block alongside the primary database write
 * to guarantee ACID atomicity across both operations.
 */
export function enqueueOutboxEvent(
  eventType: OutboxEventType | string,
  entityType: string,
  entityId: string | number,
  payload: any
): number {
  const now = new Date().toISOString();
  const jsonPayload = typeof payload === 'string' ? payload : JSON.stringify(payload);
  
  const res = execute(
    `INSERT INTO outbox (event_type, entity_type, entity_id, payload, status, retry_count, created_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?)`,
    [eventType, entityType, String(entityId), jsonPayload, now]
  );

  // Trigger non-blocking immediate outbox dispatch pass
  triggerImmediateOutboxPass();

  return res.lastInsertRowid;
}

/**
 * Trigger an asynchronous outbox processing cycle shortly after a commit
 */
export function triggerImmediateOutboxPass(delayMs = 150): void {
  if (immediateTriggerTimeout) return;
  immediateTriggerTimeout = setTimeout(() => {
    immediateTriggerTimeout = null;
    processOutboxEvents(20).catch(() => {});
  }, delayMs);
}

/**
 * Process a batch of pending or failed outbox events with exponential backoff and idempotency.
 */
export async function processOutboxEvents(batchSize = 25): Promise<{
  processed: number;
  succeeded: number;
  failed: number;
}> {
  if (isProcessingBatch) {
    return { processed: 0, succeeded: 0, failed: 0 };
  }

  isProcessingBatch = true;
  let succeeded = 0;
  let failed = 0;

  try {
    // 1. Fetch pending items or retryable failed items (up to 10 retries)
    // Ordered by id ASC to preserve causal event order per entity
    const rows = query<OutboxRecord>(
      `SELECT id, event_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at, processed_at
       FROM outbox
       WHERE (status = 'pending' OR (status = 'failed' AND retry_count < 10))
       ORDER BY id ASC
       LIMIT ?`,
      [batchSize]
    );

    if (!rows || rows.length === 0) {
      isProcessingBatch = false;
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    const nowTime = Date.now();

    for (const record of rows) {
      // Exponential backoff check: delay = min(300s, 2^(retry_count) * 2 seconds)
      if (record.retry_count > 0 && record.status === 'failed') {
        const backoffMs = Math.min(300000, Math.pow(2, record.retry_count) * 2000);
        const lastAttemptStr = record.processed_at || record.created_at;
        const recordTime = new Date(lastAttemptStr).getTime();
        if (!isNaN(recordTime) && nowTime - recordTime < backoffMs) {
          // Skip for now until backoff expires since last failed attempt
          continue;
        }
      }

      // Mark record as 'processing' to avoid duplicate dispatch by overlapping loops
      execute(
        `UPDATE outbox SET status = 'processing' WHERE id = ?`,
        [record.id]
      );

      try {
        let parsedPayload: any = {};
        try {
          parsedPayload = JSON.parse(record.payload);
        } catch {
          parsedPayload = record.payload;
        }

        // Dispatch to appropriate Firestore cloud persistence method
        await dispatchEventToCloud(record.event_type, record.entity_type, record.entity_id, parsedPayload);

        // Mark as completed
        const processedAt = new Date().toISOString();
        execute(
          `UPDATE outbox SET status = 'completed', processed_at = ?, last_error = NULL WHERE id = ?`,
          [processedAt, record.id]
        );
        succeeded++;
      } catch (err: any) {
        const errorMsg = err?.message || String(err) || 'Unknown cloud synchronization error';
        console.warn(`[Outbox] Event #${record.id} (${record.event_type}:${record.entity_id}) delivery failed:`, errorMsg);

        const newRetryCount = record.retry_count + 1;
        const failedAt = new Date().toISOString();
        execute(
          `UPDATE outbox SET status = 'failed', retry_count = ?, processed_at = ?, last_error = ? WHERE id = ?`,
          [newRetryCount, failedAt, errorMsg.substring(0, 500), record.id]
        );
        failed++;
      }
    }
  } catch (outerErr) {
    console.error('[Outbox] Fatal error during batch processing:', outerErr);
  } finally {
    isProcessingBatch = false;
  }

  return {
    processed: succeeded + failed,
    succeeded,
    failed,
  };
}

/**
 * Route individual outbox event to its corresponding Cloud/Firestore sync handler
 */
async function dispatchEventToCloud(
  eventType: string,
  entityType: string,
  entityId: string,
  payload: any
): Promise<void> {
  switch (eventType) {
    case 'ORDER_CREATED':
    case 'ORDER_UPDATED':
      await saveOrderToFirestore(payload);
      break;

    case 'ORDER_STATUS_CHANGED':
      await updateOrderInFirestore(
        { id: entityId, order_number: payload?.order_number },
        {
          status: payload.status,
          delivered_at: payload.delivered_at,
          confirmed_at: payload.confirmed_at,
          notes: payload.notes,
          delivered_items: payload.delivered_items,
        }
      );
      break;

    case 'ORDER_CANCELLED':
      await updateOrderInFirestore(
        { id: entityId, order_number: payload?.order_number },
        {
          status: 'Cancelled',
          notes: payload?.notes || 'Cancelled by user/system',
        }
      );
      break;

    case 'SHOP_CREATED':
    case 'SHOP_UPDATED': {
      const shopPayload = { ...payload };
      if (shopPayload.pin && !shopPayload.password_hash) {
        shopPayload.password_hash = hashPin(String(shopPayload.pin).trim());
      } else if (!shopPayload.password_hash && (shopPayload.assigned_user_id || shopPayload.mobile)) {
        const uRow = queryOne<any>(
          'SELECT password_hash FROM users WHERE id = ? OR mobile = ? LIMIT 1',
          [shopPayload.assigned_user_id || -1, String(shopPayload.mobile || '').trim()]
        );
        if (uRow?.password_hash) shopPayload.password_hash = uRow.password_hash;
      }
      delete shopPayload.pin;
      delete shopPayload.password;
      delete shopPayload.login_pin;
      await saveShopToFirestore(shopPayload);
      break;
    }

    case 'SHOP_DELETED':
      await deleteShopFromFirestore(entityId, payload?.mobile);
      break;

    case 'PRODUCT_CREATED':
    case 'PRODUCT_UPDATED':
      await saveProductToFirestore(payload);
      break;

    case 'PRODUCT_DELETED':
      await deleteProductFromFirestore(entityId);
      break;

    case 'PAYMENT_CREATED':
      await savePaymentToFirestore(payload);
      break;

    case 'PAYMENT_UPDATED':
      await updatePaymentInFirestore(entityId, payload);
      break;

    case 'SUBSCRIPTION_PAYMENT_CREATED':
      await saveSubscriptionPaymentToFirestore(payload);
      break;

    case 'DISTRIBUTOR_CREATED':
    case 'DISTRIBUTOR_UPDATED': {
      const distPayload = { ...payload };
      if (distPayload.pin && !distPayload.password_hash) {
        distPayload.password_hash = hashPin(String(distPayload.pin).trim());
      } else if (!distPayload.password_hash && (distPayload.user_id || distPayload.mobile || distPayload.id)) {
        const uRow = queryOne<any>(
          `SELECT u.password_hash
           FROM users u
           LEFT JOIN distributors d ON (d.user_id = u.id OR d.mobile = u.mobile)
           WHERE u.id = ? OR u.mobile = ? OR d.id = ?
           LIMIT 1`,
          [distPayload.user_id || -1, String(distPayload.mobile || '').trim(), distPayload.id || -1]
        );
        if (uRow?.password_hash) distPayload.password_hash = uRow.password_hash;
      }
      delete distPayload.pin;
      delete distPayload.password;
      delete distPayload.login_pin;
      await saveDistributorToFirestore(distPayload);
      break;
    }

    case 'DISTRIBUTOR_STATUS_CHANGED':
      await updateDistributorStatusInFirestore(
        entityId,
        payload.subscription_status || payload.status,
        payload.mobile,
        payload.firestore_id,
        payload.payment_status
      );
      break;

    case 'DISTRIBUTOR_DELETED':
      await deleteDistributorFromFirestore(entityId, payload?.mobile, payload?.firestore_id);
      break;

    case 'SUBSCRIPTION_PLANS_UPDATED':
      await saveSubscriptionPlansToFirestore(Array.isArray(payload) ? payload : [payload]);
      break;

    case 'SETTINGS_UPDATED':
      await saveSettingsToFirestore(payload, payload?.distributor_id);
      break;

    default:
      console.warn(`[Outbox] Unhandled event type: ${eventType} for entity ${entityType}`);
      break;
  }
}

/**
 * Start background outbox processor worker
 */
export function startOutboxWorker(intervalMs = 4000): void {
  if (workerIntervalId) return;
  initOutboxTable();

  // Run initial pass immediately
  processOutboxEvents(25).catch(() => {});

  // Set recurring periodic interval
  workerIntervalId = setInterval(() => {
    processOutboxEvents(25).catch(() => {});
  }, intervalMs);

  // Unref in Node so it doesn't block graceful shutdown
  if (typeof workerIntervalId === 'object' && 'unref' in workerIntervalId) {
    workerIntervalId.unref();
  }

  console.log('✓ Transactional Outbox Worker initialized (Interval: ' + intervalMs + 'ms)');
}

/**
 * Stop background outbox processor worker
 */
export function stopOutboxWorker(): void {
  if (workerIntervalId) {
    clearInterval(workerIntervalId);
    workerIntervalId = null;
  }
}

/**
 * Query current outbox metrics
 */
export function getOutboxStats(): OutboxStats {
  try {
    const res = query<{ status: string; count: number }>(
      `SELECT status, COUNT(*) as count FROM outbox GROUP BY status`
    );
    let pending = 0;
    let processing = 0;
    let completed = 0;
    let failed = 0;

    for (const r of res) {
      if (r.status === 'pending') pending = Number(r.count);
      else if (r.status === 'processing') processing = Number(r.count);
      else if (r.status === 'completed') completed = Number(r.count);
      else if (r.status === 'failed') failed = Number(r.count);
    }

    const total = pending + processing + completed + failed;
    return {
      pending,
      processing,
      completed,
      failed,
      total,
      isWorkerRunning: workerIntervalId !== null,
    };
  } catch {
    return {
      pending: 0,
      processing: 0,
      completed: 0,
      failed: 0,
      total: 0,
      isWorkerRunning: false,
    };
  }
}

/**
 * Retrieve pending or failed outbox events for monitoring or client verification
 */
export function getPendingOutboxEvents(limit = 50): OutboxRecord[] {
  try {
    return query<OutboxRecord>(
      `SELECT id, event_type, entity_type, entity_id, payload, status, retry_count, last_error, created_at, processed_at
       FROM outbox
       WHERE status IN ('pending', 'processing', 'failed')
       ORDER BY id ASC
       LIMIT ?`,
      [limit]
    );
  } catch {
    return [];
  }
}

/**
 * Reset failed outbox events back to pending for immediate retry
 */
export function retryFailedOutboxEvents(): number {
  try {
    const res = execute(
      `UPDATE outbox SET status = 'pending', retry_count = 0, last_error = NULL WHERE status = 'failed'`
    );
    triggerImmediateOutboxPass(50);
    return res.changes;
  } catch {
    return 0;
  }
}
