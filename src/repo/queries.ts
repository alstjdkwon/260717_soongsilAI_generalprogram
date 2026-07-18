import type { DB } from "../db/db";
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
  createdAt: string;
  approvedAt: string | null;
  docsArrivedAt: string | null;
  application?: ExtractedFields;
  completion?: ExtractedFields;
  applicationDocId: number | null;
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

function buildView(row: CaseRow, docs: DocRow[], review: ReviewInfo | undefined, now: number): CaseView {
  const appDoc = docs.find((d) => d.kind === "APPLICATION");
  const application = parseFields(appDoc?.extracted_fields ?? null);
  const completion = parseFields(docs.find((d) => d.kind === "COMPLETION")?.extracted_fields ?? null);
  const flags = computeFlags({
    status: row.status,
    application,
    completion,
    approvedAt: row.approved_at,
    now,
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
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    docsArrivedAt: row.docs_arrived_at,
    application,
    completion,
    applicationDocId: appDoc?.id ?? null,
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
    .prepare(`SELECT id, case_id, kind, extracted_fields FROM documents WHERE case_id IN (${placeholders})`)
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

export function getAllCaseViews(db: DB, now = Date.now()): CaseView[] {
  const rows = db.prepare(CASE_SELECT).all() as unknown as CaseRow[];
  const ids = rows.map((r) => r.id);
  const docs = loadDocs(db, ids);
  const reviews = loadReviews(db, ids);
  return rows.map((r) => buildView(r, docs.get(r.id) ?? [], reviews.get(r.id), now));
}

export function getCaseView(db: DB, id: number, now = Date.now()): CaseView | undefined {
  const row = db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id) as CaseRow | undefined;
  if (!row) return undefined;
  const docs = loadDocs(db, [id]).get(id) ?? [];
  const review = loadReviews(db, [id]).get(id);
  return buildView(row, docs, review, now);
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

export interface PendingDocView {
  id: number;
  name: string | null;
  educationName: string | null;
  amount: number | null;
  hours: number | null;
  candidates: PendingCandidate[];
  createdAt: string;
}

interface PendingRow {
  id: number;
  kind: string;
  extracted_fields: string | null;
  candidate_ids: string | null;
  created_at: string;
}

function num(v: unknown): number | null {
  if (v == null || v === "") return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** 어느 건에 붙일지 애매해 보관 중인 이수증들. 각 건의 후보 목록을 함께 실어 준다. */
export function getPendingDocuments(db: DB): PendingDocView[] {
  const rows = db
    .prepare("SELECT id, kind, extracted_fields, candidate_ids, created_at FROM pending_documents ORDER BY created_at ASC")
    .all() as unknown as PendingRow[];

  return rows.map((r) => {
    const fields = parseFields(r.extracted_fields) ?? {};
    const ids = safeParseIds(r.candidate_ids);
    const candidates: PendingCandidate[] = ids
      .map((id) => {
        const c = db
          .prepare("SELECT c.id, e.name, c.education_name, c.expected_cost FROM cases c JOIN employees e ON e.id = c.employee_id WHERE c.id = ?")
          .get(id) as { id: number; name: string; education_name: string | null; expected_cost: number | null } | undefined;
        if (!c) return null;
        return { caseId: c.id, name: c.name, educationName: c.education_name, expectedCost: c.expected_cost };
      })
      .filter((x): x is PendingCandidate => x !== null);

    return {
      id: r.id,
      name: fields.name?.value != null ? String(fields.name.value) : null,
      educationName: fields.education_name?.value != null ? String(fields.education_name.value) : null,
      amount: num(fields.amount?.value),
      hours: num(fields.hours?.value),
      candidates,
      createdAt: r.created_at,
    };
  });
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
