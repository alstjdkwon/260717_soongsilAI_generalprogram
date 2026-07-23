import type { DB } from "../db/db";
import type { Confidence } from "../domain/flags";
import type { CorrectionExample } from "../ai/rationale";

/**
 * 직무 부합 근거·교정 저장소 (Phase 5).
 * 건마다 review 행 하나를 유지한다(upsert). 교정은 축적돼 다음 근거 생성의 few-shot 이 된다.
 */

export interface Review {
  id: number;
  case_id: number;
  fit_rationale: string | null;
  fit_confidence: Confidence | null;
  correction: string | null;
  ai_rationale: string | null;
}

/** 건의 최신 review 행. */
export function getReview(db: DB, caseId: number): Review | undefined {
  return db
    .prepare("SELECT id, case_id, fit_rationale, fit_confidence, correction, ai_rationale FROM reviews WHERE case_id = ? ORDER BY id DESC LIMIT 1")
    .get(caseId) as Review | undefined;
}

/**
 * AI 근거문·신뢰도 저장(교정은 건드리지 않음). 행이 없으면 만든다.
 * ai_rationale 에도 같은 값을 남겨, 교정 후에도 AI 원문이 보존되게 한다(성과 측정용).
 */
export function saveRationale(db: DB, caseId: number, rationale: string, confidence: Confidence): void {
  const existing = getReview(db, caseId);
  if (existing) {
    db.prepare("UPDATE reviews SET fit_rationale = ?, fit_confidence = ?, ai_rationale = ? WHERE id = ?").run(rationale, confidence, rationale, existing.id);
  } else {
    db.prepare("INSERT INTO reviews (case_id, fit_rationale, fit_confidence, ai_rationale) VALUES (?, ?, ?, ?)").run(caseId, rationale, confidence, rationale);
  }
}

/**
 * 세영 님 교정 저장. 교정본이 화면에 보이는 근거문이 되고(fit_rationale 대체),
 * 사람이 확정한 값이므로 신뢰도는 HIGH. correction 은 few-shot 축적용으로 남긴다.
 *
 * ai_rationale 은 절대 건드리지 않는다 — 그래야 correction 과 비교해 "무수정 채택 vs 교정"을
 * 사후에 가릴 수 있다(성과 측정용). INSERT 분기의 ai_rationale = NULL 은 "AI 초안 없이
 * 사람이 직접 쓴 건"을 뜻하므로 그대로 두는 것이 맞다.
 */
export function saveCorrection(db: DB, caseId: number, corrected: string): void {
  const text = corrected.trim();
  const existing = getReview(db, caseId);
  if (existing) {
    db.prepare("UPDATE reviews SET correction = ?, fit_rationale = ?, fit_confidence = 'HIGH' WHERE id = ?").run(text, text, existing.id);
  } else {
    db.prepare("INSERT INTO reviews (case_id, correction, fit_rationale, fit_confidence) VALUES (?, ?, ?, 'HIGH')").run(caseId, text, text);
  }
}

/**
 * 최근 교정 사례 — 근거 생성 프롬프트의 few-shot 으로 넣는다.
 * 교정이 있는 건만, 최신 우선. 직무·교육명은 해당 건의 직원·신청 정보에서.
 */
export function getRecentCorrections(db: DB, limit = 5): CorrectionExample[] {
  const rows = db
    .prepare(
      `SELECT e.job_role AS jobRole, c.education_name AS educationName, r.correction AS correction
         FROM reviews r
         JOIN cases c ON c.id = r.case_id
         JOIN employees e ON e.id = c.employee_id
        WHERE r.correction IS NOT NULL AND TRIM(r.correction) <> ''
        ORDER BY r.id DESC
        LIMIT ?`,
    )
    .all(limit) as { jobRole: string | null; educationName: string | null; correction: string }[];
  return rows;
}
