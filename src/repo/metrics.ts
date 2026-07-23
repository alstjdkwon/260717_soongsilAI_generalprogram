import type { DB } from "../db/db";
import { getOverdueWeeks } from "./settings";

/**
 * 성과 측정 집계 (공모전 보고서용).
 *
 * queries.ts 의 CaseRow/CASE_SELECT/CaseView 를 쓰지 않고 raw SQL 로 직접 읽는다.
 * 판단보조 2단계가 그 타입들에 컬럼을 얹을 예정이라, 여기서 엮이면 같은 자리를 두 번 고치게 된다.
 *
 * 모든 집계는 표본 수(n)를 함께 돌려준다 — 3건짜리 숫자를 20건짜리처럼 읽지 않게 하기 위해서다.
 */

/** 시드(데모) 데이터를 집계에 포함할지. 기본은 실사용만. */
export type Scope = "real" | "all";

function seedFilter(scope: Scope): string {
  return scope === "real" ? "AND c.is_seed = 0" : "";
}

/** 정렬 후 가운데 값. 짝수면 두 값의 평균. 빈 배열은 null. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface Distribution {
  n: number;
  median: number | null;
  min: number | null;
  max: number | null;
}

function describe(values: number[]): Distribution {
  return {
    n: values.length,
    median: median(values),
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
  };
}

/**
 * 판단 소요시간(초) — 상세 화면을 연 뒤 승인/반려를 누르기까지.
 * 달력 시간이 아니라 실제 판단에 쓴 시간에 가깝다.
 */
export function decisionSeconds(db: DB, scope: Scope): Distribution {
  const rows = db
    .prepare(
      `SELECT c.decision_seconds AS v FROM cases c
        WHERE c.decision_seconds IS NOT NULL ${seedFilter(scope)}`,
    )
    .all() as { v: number }[];
  return describe(rows.map((r) => r.v));
}

/**
 * 신청→결정 리드타임(일) — 접수부터 승인/반려까지의 달력 시간.
 * 대기·휴가가 섞여 있어 판단 소요시간과는 다른 수치다. 둘을 같이 봐야 의미가 산다.
 */
export function leadTimeDays(db: DB, scope: Scope): Distribution {
  const rows = db
    .prepare(
      `SELECT c.created_at AS from_at, COALESCE(c.approved_at, c.rejected_at) AS to_at
         FROM cases c
        WHERE COALESCE(c.approved_at, c.rejected_at) IS NOT NULL ${seedFilter(scope)}`,
    )
    .all() as { from_at: string; to_at: string }[];

  const days = rows.map((r) => {
    const ms = Date.parse(r.to_at.replace(" ", "T")) - Date.parse(r.from_at.replace(" ", "T"));
    return Math.max(0, ms / 86_400_000);
  });
  return describe(days);
}

export interface AdoptionRate {
  /** 분모: 교정 저장을 누른 건 */
  n: number;
  /** 그 중 AI 원문 그대로인 건 */
  adopted: number;
  rate: number | null;
}

/**
 * AI 근거 무수정 채택률.
 *
 * 분모는 "교정 저장을 누른 건"뿐이다. 근거를 읽고 동의해서 그냥 승인해버리면 correction 이
 * 비어 있어 여기 안 잡힌다 — 화면에도 이 정의를 그대로 써야 오해가 없다.
 * (MEA-4 에서 채택/수정 버튼을 나누면 이 추정이 필요 없어진다.)
 */
export function rationaleAdoption(db: DB, scope: Scope): AdoptionRate {
  const rows = db
    .prepare(
      `SELECT r.ai_rationale AS ai, r.correction AS corrected
         FROM reviews r JOIN cases c ON c.id = r.case_id
        WHERE r.correction IS NOT NULL AND r.ai_rationale IS NOT NULL ${seedFilter(scope)}`,
    )
    .all() as { ai: string; corrected: string }[];

  const adopted = rows.filter((r) => r.ai.trim() === r.corrected.trim()).length;
  return { n: rows.length, adopted, rate: rows.length ? adopted / rows.length : null };
}

export interface OverdueCount {
  /** 분모: 이수 대기 중인 건 */
  n: number;
  overdue: number;
  limitWeeks: number;
}

/** 이수 대기 중 설정 기준(기본 4주)을 넘긴 건수. */
export function overdueCases(db: DB, scope: Scope, now = Date.now()): OverdueCount {
  const limitWeeks = getOverdueWeeks(db);
  const rows = db
    .prepare(
      `SELECT c.approved_at AS approved_at FROM cases c
        WHERE c.status = 'IN_PROGRESS' AND c.approved_at IS NOT NULL ${seedFilter(scope)}`,
    )
    .all() as { approved_at: string }[];

  const overdue = rows.filter((r) => {
    const weeks = (now - Date.parse(r.approved_at.replace(" ", "T"))) / (7 * 86_400_000);
    return weeks >= limitWeeks;
  }).length;
  return { n: rows.length, overdue, limitWeeks };
}

export interface MetricsSummary {
  scope: Scope;
  totalCases: number;
  decisionSeconds: Distribution;
  leadTimeDays: Distribution;
  adoption: AdoptionRate;
  overdue: OverdueCount;
}

export function getMetrics(db: DB, scope: Scope, now = Date.now()): MetricsSummary {
  const total = db
    .prepare(`SELECT COUNT(*) AS n FROM cases c WHERE 1=1 ${seedFilter(scope)}`)
    .get() as { n: number };
  return {
    scope,
    totalCases: total.n,
    decisionSeconds: decisionSeconds(db, scope),
    leadTimeDays: leadTimeDays(db, scope),
    adoption: rationaleAdoption(db, scope),
    overdue: overdueCases(db, scope, now),
  };
}

/* ── 원시데이터 (엑셀 교차검증용) ─────────────────────────── */

export interface CaseRawRow {
  case_id: number;
  is_seed: number;
  status: string;
  created_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  refunded_at: string | null;
  decision_seconds: number | null;
  lead_days: number | null;
}

/** 건별 원시 행 — 판단 소요시간·리드타임·방치 지표를 손으로 재계산할 수 있게 한다. */
export function caseRawRows(db: DB, scope: Scope): CaseRawRow[] {
  const rows = db
    .prepare(
      `SELECT c.id AS case_id, c.is_seed, c.status, c.created_at, c.approved_at,
              c.rejected_at, c.refunded_at, c.decision_seconds
         FROM cases c WHERE 1=1 ${seedFilter(scope)}
        ORDER BY c.id`,
    )
    .all() as Omit<CaseRawRow, "lead_days">[];

  return rows.map((r) => {
    const to = r.approved_at ?? r.rejected_at;
    const lead = to
      ? Math.max(0, (Date.parse(to.replace(" ", "T")) - Date.parse(r.created_at.replace(" ", "T"))) / 86_400_000)
      : null;
    return { ...r, lead_days: lead === null ? null : Math.round(lead * 10) / 10 };
  });
}

export interface FieldRawRow {
  document_id: number;
  case_id: number;
  field: string;
  ai_value: string;
  ai_confidence: string;
  final_value: string;
  verdict: string;
}

type Extracted = Record<string, { value: string | number | null; confidence: string }>;

/**
 * 필드별 AI 원본 ↔ 최종값 비교 행.
 *
 * 주의: 사람이 확인했는지 여부(fields_reviewed_at)가 아직 없어서, "일치"에는 실제로 맞은 것과
 * 아예 열어보지 않은 것이 섞여 있다. OCR 정확도를 지표로 쓰려면 MEA-4 가 선행되어야 한다.
 * 지금은 원시 대조표로만 쓴다.
 */
export function fieldRawRows(db: DB, scope: Scope): FieldRawRow[] {
  const docs = db
    .prepare(
      `SELECT d.id AS document_id, d.case_id, d.extracted_original AS orig, d.extracted_fields AS final
         FROM documents d JOIN cases c ON c.id = d.case_id
        WHERE d.extracted_original IS NOT NULL ${seedFilter(scope)}
        ORDER BY d.id`,
    )
    .all() as { document_id: number; case_id: number; orig: string; final: string | null }[];

  const out: FieldRawRow[] = [];
  for (const d of docs) {
    const orig = safeParse(d.orig);
    const final = safeParse(d.final ?? "{}");
    const keys = new Set([...Object.keys(orig), ...Object.keys(final)]);

    for (const key of keys) {
      const a = orig[key];
      const b = final[key];
      const verdict = !a ? "AI누락(사람이 채움)" : !b ? "삭제(문서에 없음)" : String(a.value) === String(b.value) ? "일치" : "수정";
      out.push({
        document_id: d.document_id,
        case_id: d.case_id,
        field: key,
        ai_value: a?.value == null ? "" : String(a.value),
        ai_confidence: a?.confidence ?? "",
        final_value: b?.value == null ? "" : String(b.value),
        verdict,
      });
    }
  }
  return out;
}

export interface RationaleRawRow {
  case_id: number;
  ai_rationale: string;
  correction: string;
  same: string;
}

/** AI 근거 원문 ↔ 교정본 비교 행 — 채택률을 손으로 재계산할 수 있게 한다. */
export function rationaleRawRows(db: DB, scope: Scope): RationaleRawRow[] {
  const rows = db
    .prepare(
      `SELECT r.case_id, r.ai_rationale AS ai, r.correction AS corrected
         FROM reviews r JOIN cases c ON c.id = r.case_id
        WHERE r.ai_rationale IS NOT NULL ${seedFilter(scope)}
        ORDER BY r.case_id`,
    )
    .all() as { case_id: number; ai: string; corrected: string | null }[];

  return rows.map((r) => ({
    case_id: r.case_id,
    ai_rationale: r.ai,
    correction: r.corrected ?? "",
    same: r.corrected == null ? "미검토" : r.ai.trim() === r.corrected.trim() ? "채택" : "수정",
  }));
}

function safeParse(json: string): Extracted {
  try {
    return JSON.parse(json) as Extracted;
  } catch {
    return {};
  }
}
