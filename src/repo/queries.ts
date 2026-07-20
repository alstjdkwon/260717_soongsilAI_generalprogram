import type { DB } from "../db/db";
import { getOverdueWeeks } from "./settings";
import { CASE_STATUS, type CaseStatus } from "../domain/status";
import {
  bucketOf,
  computeFlags,
  flagReason,
  type CaseFlags,
  type Confidence,
  type ExtractedFields,
  type QueueBucket,
} from "../domain/flags";

export interface CaseView {
  id: number;
  employeeId: number;
  name: string;
  department: string | null;
  jobRole: string | null;
  remainingPoints: number | null;
  educationName: string | null;
  expectedCost: number | null;
  status: CaseStatus;
  statusLabel: string;
  rejectReason: string | null;
  prevCaseId: number | null;
  /** 재신청 건이면 이전 반려 사유(카드·상세에 표시). */
  prevRejectReason: string | null;
  createdAt: string;
  approvedAt: string | null;
  docsArrivedAt: string | null;
  application?: ExtractedFields;
  completion?: ExtractedFields;
  applicationDocId: number | null;
  /** 이 건에 딸린 원본 문서들(신청서·이수증…) — 화면에서 보고 고칠 대상. */
  documents: CaseDocument[];
  fitRationale: string | null;
  fitConfidence: Confidence | null;
  flags: CaseFlags;
  reason: string | null;
  bucket: QueueBucket;
  /** 접수 후 경과 일수. */
  ageDays: number;
}

interface CaseRow {
  id: number;
  employee_id: number;
  name: string;
  department: string | null;
  job_role: string | null;
  remaining_points: number | null;
  education_name: string | null;
  expected_cost: number | null;
  status: CaseStatus;
  reject_reason: string | null;
  prev_case_id: number | null;
  created_at: string;
  approved_at: string | null;
  docs_arrived_at: string | null;
}

interface DocRow {
  id: number;
  case_id: number;
  kind: string;
  extracted_fields: string | null;
  file_path: string | null;
}

/** 건에 딸린 원본 문서 하나 — 상세화면의 PDF 뷰어·수기 수정 대상. */
export interface CaseDocument {
  id: number;
  kind: string;
  filePath: string | null;
  fields: ExtractedFields;
}

function parseFields(json: string | null): ExtractedFields | undefined {
  if (!json) return undefined;
  try {
    return JSON.parse(json) as ExtractedFields;
  } catch {
    return undefined;
  }
}

function daysBetween(fromIso: string, now: number): number {
  const ms = now - Date.parse(fromIso.replace(" ", "T"));
  return Math.max(0, Math.floor(ms / 86_400_000));
}

interface ReviewInfo {
  rationale: string | null;
  confidence: Confidence | null;
}

function buildView(
  row: CaseRow,
  docs: DocRow[],
  review: ReviewInfo | undefined,
  now: number,
  overdueWeeks: number,
  prevRejectReason: string | null,
): CaseView {
  const appDoc = docs.find((d) => d.kind === "APPLICATION");
  const application = parseFields(appDoc?.extracted_fields ?? null);
  const completion = parseFields(docs.find((d) => d.kind === "COMPLETION")?.extracted_fields ?? null);
  const flags = computeFlags({
    status: row.status,
    application,
    completion,
    approvedAt: row.approved_at,
    now,
    overdueWeeks,
  });
  return {
    id: row.id,
    employeeId: row.employee_id,
    name: row.name,
    department: row.department,
    jobRole: row.job_role,
    remainingPoints: row.remaining_points,
    educationName: row.education_name,
    expectedCost: row.expected_cost,
    status: row.status,
    statusLabel: CASE_STATUS[row.status],
    rejectReason: row.reject_reason,
    prevCaseId: row.prev_case_id,
    prevRejectReason,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    docsArrivedAt: row.docs_arrived_at,
    application,
    completion,
    applicationDocId: appDoc?.id ?? null,
    documents: docs.map((d) => ({
      id: d.id,
      kind: d.kind,
      filePath: d.file_path,
      fields: parseFields(d.extracted_fields) ?? {},
    })),
    fitRationale: review?.rationale ?? null,
    fitConfidence: review?.confidence ?? null,
    flags,
    reason: flagReason(flags),
    bucket: bucketOf(row.status, flags),
    ageDays: daysBetween(row.created_at, now),
  };
}

const CASE_SELECT = `
  SELECT c.id, c.employee_id, e.name, e.department, e.job_role, e.remaining_points,
         c.education_name, c.expected_cost, c.status, c.reject_reason, c.prev_case_id,
         c.created_at, c.approved_at, c.docs_arrived_at
    FROM cases c
    JOIN employees e ON e.id = c.employee_id
`;

function loadDocs(db: DB, caseIds: number[]): Map<number, DocRow[]> {
  const byCase = new Map<number, DocRow[]>();
  if (caseIds.length === 0) return byCase;
  const placeholders = caseIds.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, case_id, kind, extracted_fields, file_path FROM documents WHERE case_id IN (${placeholders})`)
    .all(...caseIds) as unknown as DocRow[];
  for (const r of rows) {
    const list = byCase.get(r.case_id) ?? [];
    list.push(r);
    byCase.set(r.case_id, list);
  }
  return byCase;
}

function loadReviews(db: DB, caseIds: number[]): Map<number, ReviewInfo> {
  const byCase = new Map<number, ReviewInfo>();
  if (caseIds.length === 0) return byCase;
  const placeholders = caseIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT case_id, fit_rationale, fit_confidence FROM reviews
        WHERE case_id IN (${placeholders}) AND fit_rationale IS NOT NULL
        ORDER BY id ASC`,
    )
    .all(...caseIds) as { case_id: number; fit_rationale: string; fit_confidence: Confidence | null }[];
  // 최신 근거가 마지막이라 덮어씀
  for (const r of rows) byCase.set(r.case_id, { rationale: r.fit_rationale, confidence: r.fit_confidence });
  return byCase;
}

/** 재신청 건들의 이전(반려) 건 사유를 한 번에 — prev_case_id → 반려 사유. */
function loadPrevRejectReasons(db: DB, prevIds: number[]): Map<number, string | null> {
  const byId = new Map<number, string | null>();
  const ids = [...new Set(prevIds)];
  if (ids.length === 0) return byId;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(`SELECT id, reject_reason FROM cases WHERE id IN (${placeholders})`)
    .all(...ids) as { id: number; reject_reason: string | null }[];
  for (const r of rows) byId.set(r.id, r.reject_reason);
  return byId;
}

export function getAllCaseViews(db: DB, now = Date.now()): CaseView[] {
  const rows = db.prepare(CASE_SELECT).all() as unknown as CaseRow[];
  const ids = rows.map((r) => r.id);
  const docs = loadDocs(db, ids);
  const reviews = loadReviews(db, ids);
  const overdueWeeks = getOverdueWeeks(db);
  const prevReasons = loadPrevRejectReasons(
    db,
    rows.map((r) => r.prev_case_id).filter((x): x is number => x != null),
  );
  return rows.map((r) =>
    buildView(r, docs.get(r.id) ?? [], reviews.get(r.id), now, overdueWeeks, r.prev_case_id != null ? prevReasons.get(r.prev_case_id) ?? null : null),
  );
}

export function getCaseView(db: DB, id: number, now = Date.now()): CaseView | undefined {
  const row = db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id) as CaseRow | undefined;
  if (!row) return undefined;
  const docs = loadDocs(db, [id]).get(id) ?? [];
  const review = loadReviews(db, [id]).get(id);
  const prevReason = row.prev_case_id != null ? loadPrevRejectReasons(db, [row.prev_case_id]).get(row.prev_case_id) ?? null : null;
  return buildView(row, docs, review, now, getOverdueWeeks(db), prevReason);
}

export interface QueueData {
  review: CaseView[];
  processing: CaseView[];
  overdue: CaseView[];
}

/** 할일 큐 세 갈래. 각 갈래는 riskScore 내림차순(저신뢰+방치 임박이 위)으로 정렬. */
export function getQueue(db: DB, now = Date.now()): QueueData {
  const views = getAllCaseViews(db, now);
  const byRisk = (a: CaseView, b: CaseView) =>
    b.flags.riskScore - a.flags.riskScore || a.createdAt.localeCompare(b.createdAt);
  return {
    review: views.filter((v) => v.bucket === "REVIEW").sort(byRisk),
    processing: views.filter((v) => v.bucket === "PROCESSING").sort(byRisk),
    overdue: views.filter((v) => v.bucket === "OVERDUE").sort(byRisk),
  };
}

export const BOARD_COLUMNS: CaseStatus[] = [
  "SCREENING",
  "IN_PROGRESS",
  "AWAITING_REFUND",
  "DONE",
  "REJECTED",
];

/** 칸반: 상태별 열. 각 열은 최신 접수가 위로. */
export function getBoard(db: DB, now = Date.now()): Record<CaseStatus, CaseView[]> {
  const views = getAllCaseViews(db, now);
  const out = Object.fromEntries(BOARD_COLUMNS.map((s) => [s, [] as CaseView[]])) as Record<CaseStatus, CaseView[]>;
  for (const v of views) out[v.status].push(v);
  for (const s of BOARD_COLUMNS) out[s].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return out;
}

// ── 후보 확인 보관함(pending_documents) — Phase 4 ─────────

export interface PendingCandidate {
  caseId: number;
  name: string;
  educationName: string | null;
  expectedCost: number | null;
}

/** 부서 불일치로 보류된 신청서에서, 이름이 같은 기존 직원 후보. */
export interface PendingEmployee {
  employeeId: number;
  name: string;
  department: string | null;
  caseCount: number;
}

/** 중복 의심으로 보류된 신청서에서, 이미 진행중인 같은 교육 건. */
export interface PendingConflict {
  caseId: number;
  employeeId: number;
  educationName: string | null;
  status: CaseStatus;
  createdAt: string;
}

export interface PendingDocView {
  id: number;
  /** 이수증 보류는 null, 신청서 보류는 DEPT_MISMATCH | DUPLICATE. */
  holdReason: "DEPT_MISMATCH" | "DUPLICATE" | null;
  name: string | null;
  department: string | null;
  educationName: string | null;
  amount: number | null;
  hours: number | null;
  /** 이수증 보류에서만 채워진다 — 붙일 수 있는 심사 건. */
  candidates: PendingCandidate[];
  /** DEPT_MISMATCH 에서만 채워진다 — 이름이 같은 기존 직원. */
  sameNameEmployees: PendingEmployee[];
  /** DUPLICATE 에서만 채워진다 — 충돌한 진행중 건. */
  conflict: PendingConflict | null;
  createdAt: string;
}

interface PendingRow {
  id: number;
  kind: string;
  hold_reason: string | null;
  extracted_fields: string | null;
  candidate_ids: string | null;
  created_at: string;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 자동 처리가 위험해 보관 중인 문서들. 보류 사유에 따라 사람이 결정할 때 필요한 정보를 함께 실어 준다.
 *  - 이수증(holdReason null) → 붙일 수 있는 심사 건 후보
 *  - 부서 불일치(DEPT_MISMATCH) → 이름이 같은 기존 직원들
 *  - 중복 의심(DUPLICATE) → 충돌한 진행중 건
 */
export function getPendingDocuments(db: DB): PendingDocView[] {
  const rows = db
    .prepare(
      "SELECT id, kind, hold_reason, extracted_fields, candidate_ids, created_at FROM pending_documents ORDER BY created_at ASC",
    )
    .all() as unknown as PendingRow[];

  return rows.map((r) => {
    const fields = parseFields(r.extracted_fields) ?? {};
    const ids = safeParseIds(r.candidate_ids);
    const holdReason = r.hold_reason === "DEPT_MISMATCH" || r.hold_reason === "DUPLICATE" ? r.hold_reason : null;

    return {
      id: r.id,
      holdReason,
      name: fields.name?.value != null ? String(fields.name.value) : null,
      department: fields.department?.value != null ? String(fields.department.value) : null,
      educationName: fields.education_name?.value != null ? String(fields.education_name.value) : null,
      amount: num(fields.amount?.value),
      hours: num(fields.hours?.value),
      candidates: holdReason === null ? loadCandidates(db, ids) : [],
      sameNameEmployees: holdReason === "DEPT_MISMATCH" ? loadEmployees(db, ids) : [],
      conflict: holdReason === "DUPLICATE" ? loadConflict(db, ids[0]) : null,
      createdAt: r.created_at,
    };
  });
}

function loadCandidates(db: DB, ids: number[]): PendingCandidate[] {
  return ids
    .map((id) => {
      const c = db
        .prepare("SELECT c.id, e.name, c.education_name, c.expected_cost FROM cases c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?")
        .get(id) as { id: number; name: string; education_name: string | null; expected_cost: number | null } | undefined;
      if (!c) return null;
      return { caseId: c.id, name: c.name, educationName: c.education_name, expectedCost: c.expected_cost };
    })
    .filter((x): x is PendingCandidate => x !== null);
}

function loadEmployees(db: DB, ids: number[]): PendingEmployee[] {
  return ids
    .map((id) => {
      const e = db
        .prepare(
          `SELECT e.id, e.name, e.department,
                  (SELECT COUNT(*) FROM cases c WHERE c.employee_id = e.id) AS case_count
             FROM employees e WHERE e.id = ?`,
        )
        .get(id) as { id: number; name: string; department: string | null; case_count: number } | undefined;
      if (!e) return null;
      return { employeeId: e.id, name: e.name, department: e.department, caseCount: e.case_count };
    })
    .filter((x): x is PendingEmployee => x !== null);
}

function loadConflict(db: DB, caseId: number | undefined): PendingConflict | null {
  if (caseId == null) return null;
  const c = db
    .prepare("SELECT id, employee_id, education_name, status, created_at FROM cases WHERE id = ?")
    .get(caseId) as
    | { id: number; employee_id: number; education_name: string | null; status: CaseStatus; created_at: string }
    | undefined;
  if (!c) return null;
  return {
    caseId: c.id,
    employeeId: c.employee_id,
    educationName: c.education_name,
    status: c.status,
    createdAt: c.created_at,
  };
}

function safeParseIds(json: string | null): number[] {
  if (!json) return [];
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x) => typeof x === "number") : [];
  } catch {
    return [];
  }
}

/**
 * 보관 중인 이수증을 수동으로 붙일 수 있는 건 목록 — 이수 대기이고 아직 이수증이 없는 건 전부.
 * 이름 매칭이 실패했을 때(오탈자·OCR 실패) 세영 님이 직접 고르는 데 쓴다.
 */
export function getAttachableCases(db: DB): PendingCandidate[] {
  const rows = db
    .prepare(
      `SELECT c.id, e.name, c.education_name, c.expected_cost
         FROM cases c
         JOIN employees e ON e.id = c.employee_id
        WHERE c.status = 'IN_PROGRESS'
          AND NOT EXISTS (
            SELECT 1 FROM documents d WHERE d.case_id = c.id AND d.kind = 'COMPLETION'
          )
        ORDER BY e.name ASC`,
    )
    .all() as { id: number; name: string; education_name: string | null; expected_cost: number | null }[];
  return rows.map((r) => ({
    caseId: r.id,
    name: r.name,
    educationName: r.education_name,
    expectedCost: r.expected_cost,
  }));
}
