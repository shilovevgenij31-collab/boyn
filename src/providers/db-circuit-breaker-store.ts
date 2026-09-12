/**
 * Durable circuit-breaker state via Phase 3's `app_settings` table
 * (Phase 4 brief §18: must survive a Vercel cold start — no Redis, no
 * module-memory-only state). Kept in its own file so
 * circuit-breaker.ts's pure logic has zero DB dependency and stays
 * trivially unit-testable.
 */
import type { Database } from "@/db/client.ts";
import { getSetting, setSetting } from "@/db/repositories/settings.ts";
import {
  circuitKeyToString,
  CLOSED_CIRCUIT,
  type CircuitBreakerStore,
  type CircuitKey,
  type CircuitRecord,
} from "./circuit-breaker.ts";

/** JSON-serializable form — CircuitRecord.openedAt is a Date, which
 * app_settings.value (jsonb) can't round-trip directly. */
interface StoredCircuitRecord {
  state: "closed" | "open";
  consecutiveFailures: number;
  openedAt: string | null;
}

function toStored(record: CircuitRecord): StoredCircuitRecord {
  return { ...record, openedAt: record.openedAt?.toISOString() ?? null };
}

function fromStored(stored: StoredCircuitRecord): CircuitRecord {
  return { ...stored, openedAt: stored.openedAt ? new Date(stored.openedAt) : null };
}

export class DbCircuitBreakerStore implements CircuitBreakerStore {
  constructor(private readonly db: Database) {}

  async get(key: CircuitKey): Promise<CircuitRecord> {
    const stored = await getSetting<StoredCircuitRecord>(this.db, circuitKeyToString(key));
    return stored ? fromStored(stored) : { ...CLOSED_CIRCUIT };
  }

  async save(key: CircuitKey, record: CircuitRecord): Promise<void> {
    await setSetting(this.db, circuitKeyToString(key), toStored(record), new Date());
  }
}
