/**
 * Durable Telegram access registry (Phase 8/9 hotfix, production
 * incident Parts H-L): an in-bot access-request/approval flow, backed by
 * `telegram_users`, so granting a new user access doesn't require the
 * owner to manually discover their numeric Telegram id via a third-party
 * bot first. `user_id` is the only identity ever checked for
 * authorization (see telegram/auth.ts) — `username`/`chat_id`/
 * `first_name` are display/notification metadata only, refreshed on
 * every `/start`, and NEVER used to grant access (a changed or reused
 * username must never inherit a previous user's access).
 */
import { and, eq } from "drizzle-orm";
import type { Database } from "@/db/client.ts";
import { telegramUsers } from "@/db/schema.ts";

export type TelegramUserRole = "USER" | "ADMIN";
export type TelegramUserStatus = "PENDING" | "ACTIVE" | "DENIED";

export interface TelegramUserRow {
  userId: number;
  chatId: number | null;
  username: string | null;
  firstName: string | null;
  role: TelegramUserRole;
  status: TelegramUserStatus;
  requestedAt: Date;
  approvedAt: Date | null;
  approvedBy: number | null;
  updatedAt: Date;
}

export async function getTelegramUser(db: Database, userId: number): Promise<TelegramUserRow | null> {
  const rows = await db.select().from(telegramUsers).where(eq(telegramUsers.userId, userId)).limit(1);
  return rows[0] ?? null;
}

export interface UpsertAccessRequestParams {
  userId: number;
  chatId: number;
  username: string | null;
  firstName: string | null;
  now: Date;
}

export interface UpsertAccessRequestResult {
  /** True only the very first time this userId has ever sent /start —
   * this is what should trigger "notify every admin" (repeated /starts
   * from an already-PENDING/ACTIVE/DENIED user never re-notify). */
  isNewRequest: boolean;
  row: TelegramUserRow;
}

/** Called on every `/start` from a user not already authorized via env.
 * Always refreshes the display metadata (username/chatId/firstName can
 * legitimately change), but NEVER touches `role`/`status`/`approvedAt`/
 * `approvedBy` for an existing row — a returning ACTIVE/ADMIN/DENIED user
 * must not be silently reset back to PENDING. */
export async function upsertAccessRequest(db: Database, params: UpsertAccessRequestParams): Promise<UpsertAccessRequestResult> {
  const existing = await getTelegramUser(db, params.userId);
  if (existing) {
    await db
      .update(telegramUsers)
      .set({ chatId: params.chatId, username: params.username, firstName: params.firstName, updatedAt: params.now })
      .where(eq(telegramUsers.userId, params.userId));
    return { isNewRequest: false, row: { ...existing, chatId: params.chatId, username: params.username, firstName: params.firstName, updatedAt: params.now } };
  }

  const inserted = await db
    .insert(telegramUsers)
    .values({
      userId: params.userId,
      chatId: params.chatId,
      username: params.username,
      firstName: params.firstName,
      role: "USER",
      status: "PENDING",
      requestedAt: params.now,
      updatedAt: params.now,
    })
    .onConflictDoNothing({ target: telegramUsers.userId })
    .returning();

  if (inserted.length === 0) {
    // Lost a race against a concurrent /start from the same user — the
    // other request already created the row; re-read it rather than
    // treating this as a fresh request (avoids a duplicate admin notify).
    const row = await getTelegramUser(db, params.userId);
    return { isNewRequest: false, row: row! };
  }
  return { isNewRequest: true, row: inserted[0]! };
}

export interface ApplyDecisionParams {
  userId: number;
  role: TelegramUserRole;
  approvedBy: number;
  now: Date;
}

export interface ApplyDecisionResult {
  /** False when the row was already exactly in this state (same status +
   * role) — the caller uses this to stay idempotent: no duplicate
   * audit/notification on a repeated callback tap. */
  changed: boolean;
  row: TelegramUserRow | null;
}

/** ALLOW ("USER") or ADMIN — both are the same "grant access" decision,
 * differing only in which role is granted. */
export async function approveTelegramUser(db: Database, params: ApplyDecisionParams): Promise<ApplyDecisionResult> {
  const existing = await getTelegramUser(db, params.userId);
  if (!existing) return { changed: false, row: null };
  if (existing.status === "ACTIVE" && existing.role === params.role) {
    return { changed: false, row: existing };
  }

  await db
    .update(telegramUsers)
    .set({ role: params.role, status: "ACTIVE", approvedAt: params.now, approvedBy: params.approvedBy, updatedAt: params.now })
    .where(eq(telegramUsers.userId, params.userId));
  return { changed: true, row: { ...existing, role: params.role, status: "ACTIVE", approvedAt: params.now, approvedBy: params.approvedBy, updatedAt: params.now } };
}

export async function denyTelegramUser(db: Database, params: Omit<ApplyDecisionParams, "role">): Promise<ApplyDecisionResult> {
  const existing = await getTelegramUser(db, params.userId);
  if (!existing) return { changed: false, row: null };
  if (existing.status === "DENIED") return { changed: false, row: existing };

  await db
    .update(telegramUsers)
    .set({ status: "DENIED", approvedAt: params.now, approvedBy: params.approvedBy, updatedAt: params.now })
    .where(eq(telegramUsers.userId, params.userId));
  return { changed: true, row: { ...existing, status: "DENIED", approvedAt: params.now, approvedBy: params.approvedBy, updatedAt: params.now } };
}

export interface ActiveTelegramAuthIds {
  /** ACTIVE, any role — every ADMIN is implicitly included here too
   * (role is orthogonal to "may use the bot at all"), matching env's own
   * "admin implicitly has normal-user access" rule. */
  userIds: number[];
  /** ACTIVE and role=ADMIN only. */
  adminUserIds: number[];
}

/** Read once per request (build-context.ts) and merged into
 * TelegramAuthConfig's existing env-derived Sets — auth.ts's
 * isAuthorized/isAdmin stay pure, synchronous, and completely unchanged. */
export async function getActiveTelegramAuthIds(db: Database): Promise<ActiveTelegramAuthIds> {
  const rows = await db
    .select({ userId: telegramUsers.userId, role: telegramUsers.role })
    .from(telegramUsers)
    .where(eq(telegramUsers.status, "ACTIVE"));

  const userIds: number[] = [];
  const adminUserIds: number[] = [];
  for (const row of rows) {
    userIds.push(row.userId);
    if (row.role === "ADMIN") adminUserIds.push(row.userId);
  }
  return { userIds, adminUserIds };
}

/** All ACTIVE/PENDING superadmins to notify on a new access request —
 * env-configured admins are notified by the caller directly (it already
 * has their ids); this covers DB-granted admins too, so a second admin
 * approved through this same flow also sees future requests. */
export async function listActiveAdmins(db: Database): Promise<TelegramUserRow[]> {
  return db.select().from(telegramUsers).where(and(eq(telegramUsers.status, "ACTIVE"), eq(telegramUsers.role, "ADMIN")));
}
