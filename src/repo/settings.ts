import type { DB } from "../db/db";
import { DEFAULT_OVERDUE_WEEKS } from "../domain/flags";

/**
 * 도구 설정 (Phase 6). 지금은 경과 알림 기준(주)만.
 * 실제 이수 기한이 확정되면 세영 님이 값만 바꿔 조정한다(코드 수정 없이).
 */

const OVERDUE_KEY = "overdue_weeks";

export function getSetting(db: DB, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setSetting(db: DB, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** 이수 대기 경과 알림 기준(주). 미설정이면 기본 4주. */
export function getOverdueWeeks(db: DB): number {
  const raw = getSetting(db, OVERDUE_KEY);
  const n = raw != null ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_OVERDUE_WEEKS;
}

/** 경과 알림 기준을 저장한다. 1~52주로 제한. */
export function setOverdueWeeks(db: DB, weeks: number): void {
  const clamped = Math.min(52, Math.max(1, Math.round(weeks)));
  setSetting(db, OVERDUE_KEY, String(clamped));
}
