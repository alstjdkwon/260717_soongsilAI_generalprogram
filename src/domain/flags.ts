/**
 * AI 추출 신뢰도 · 대조 불일치 · 방치(경과) 를 계산해 각 건을 할일 큐로 라우팅한다.
 *
 * 기획서 §5: 할일 큐는 세 갈래 — 처리 대기 / 검토 필요 / 경과 알림.
 * "검토 필요"(저신뢰·불일치)는 빈도는 낮지만 시각적 무게가 가장 크다 — 에러가 숨는 곳.
 * 이 모듈은 DB·UI 에 의존하지 않는 순수 계산이라 규칙을 단위 테스트로 고정한다.
 */

import type { CaseStatus } from "./status";

export type Confidence = "HIGH" | "MID" | "LOW";

/** AI 가 문서에서 뽑은 필드 하나 — 값과 필드별 신뢰도. */
export interface ExtractedField {
  value: string | number | null;
  confidence: Confidence;
}

export interface ExtractedFields {
  name?: ExtractedField;
  department?: ExtractedField;
  education_name?: ExtractedField;
  amount?: ExtractedField;
  hours?: ExtractedField;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_OVERDUE_WEEKS = 4;

const CONFIDENCE_RANK: Record<Confidence, number> = { HIGH: 2, MID: 1, LOW: 0 };

export type MismatchField = "name" | "education_name" | "amount";

export interface Mismatch {
  field: MismatchField;
  applied: string;
  submitted: string;
}

export interface CaseFlags {
  /** 존재하는 필드 중 가장 낮은 신뢰도. 필드가 없으면 HIGH 로 본다. */
  minConfidence: Confidence;
  /** 신청 내용 ↔ 제출 서류 대조 불일치 목록. */
  mismatches: Mismatch[];
  /** 이수 대기 경과 주수 (해당 없으면 0). */
  overdueWeeks: number;
  needsReview: boolean;
  isOverdue: boolean;
  /** 큐 정렬용. 클수록 위로 — "저신뢰 + 방치 임박"이 상단(기획서 §5). */
  riskScore: number;
}

export interface CaseFlagInput {
  status: CaseStatus;
  application?: ExtractedFields;
  completion?: ExtractedFields;
  /** 승인 시각(ISO/‘YYYY-MM-DD HH:MM:SS’). 이수 대기 경과 계산 기준. */
  approvedAt?: string | null;
  now: number;
  overdueWeeks?: number;
}

function lowestConfidence(...sets: (ExtractedFields | undefined)[]): Confidence {
  let rank = CONFIDENCE_RANK.HIGH;
  for (const set of sets) {
    if (!set) continue;
    for (const field of Object.values(set) as (ExtractedField | undefined)[]) {
      if (field) rank = Math.min(rank, CONFIDENCE_RANK[field.confidence]);
    }
  }
  return (Object.keys(CONFIDENCE_RANK) as Confidence[]).find(
    (c) => CONFIDENCE_RANK[c] === rank,
  )!;
}

function norm(v: string | number | null | undefined): string {
  return String(v ?? "").trim().toLowerCase().replace(/\s+/g, "");
}

/** 신청서와 제출서류가 둘 다 있을 때만 대조 — 이름·교육명·금액 불일치. */
function findMismatches(
  application?: ExtractedFields,
  completion?: ExtractedFields,
): Mismatch[] {
  if (!application || !completion) return [];
  const out: Mismatch[] = [];
  const fields: MismatchField[] = ["name", "education_name", "amount"];
  for (const field of fields) {
    const a = application[field];
    const b = completion[field];
    if (a?.value == null || b?.value == null) continue;
    if (norm(a.value) !== norm(b.value)) {
      out.push({ field, applied: String(a.value), submitted: String(b.value) });
    }
  }
  return out;
}

export function computeFlags(input: CaseFlagInput): CaseFlags {
  const overdueLimit = input.overdueWeeks ?? DEFAULT_OVERDUE_WEEKS;
  const minConfidence = lowestConfidence(input.application, input.completion);
  const mismatches = findMismatches(input.application, input.completion);

  let overdueWeeks = 0;
  if (input.status === "IN_PROGRESS" && input.approvedAt) {
    const elapsed = input.now - Date.parse(input.approvedAt.replace(" ", "T"));
    overdueWeeks = elapsed > 0 ? Math.floor(elapsed / WEEK_MS) : 0;
  }
  const isOverdue = overdueWeeks >= overdueLimit;
  const needsReview = minConfidence === "LOW" || mismatches.length > 0;

  const riskScore =
    mismatches.length * 100 +
    (minConfidence === "LOW" ? 50 : minConfidence === "MID" ? 15 : 0) +
    overdueWeeks * 8;

  return { minConfidence, mismatches, overdueWeeks, needsReview, isOverdue, riskScore };
}

export type QueueBucket = "REVIEW" | "PROCESSING" | "OVERDUE" | "NONE";

/**
 * 카드 하나는 한 곳에만 — 검토 필요(가장 강함) > 처리 대기 > 경과 알림 순으로 배정.
 * 처리 대기 = 세영 님이 직접 결정할 단계(심사·환급).
 */
export function bucketOf(status: CaseStatus, flags: CaseFlags): QueueBucket {
  // 종료 상태(완료·반려)는 더 볼 것이 없으므로 큐에서 제외 — 저신뢰 필드가 남아 있어도.
  if (status === "DONE" || status === "REJECTED") return "NONE";
  if (flags.needsReview) return "REVIEW";
  if (status === "SCREENING" || status === "AWAITING_REFUND") return "PROCESSING";
  if (flags.isOverdue) return "OVERDUE";
  return "NONE";
}

const FIELD_LABEL: Record<MismatchField, string> = {
  name: "이름",
  education_name: "교육명",
  amount: "금액",
};

function won(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) ? `${n.toLocaleString("ko-KR")}원` : v;
}

/** 카드·상세 배너에 쓸 "왜 당신이 봐야 하는가" 한 문장. 플래그 없으면 null. */
export function flagReason(flags: CaseFlags): string | null {
  if (flags.mismatches.length > 0) {
    const m = flags.mismatches[0];
    const applied = m.field === "amount" ? won(m.applied) : m.applied;
    const submitted = m.field === "amount" ? won(m.submitted) : m.submitted;
    return `${FIELD_LABEL[m.field]} 불일치 — 신청 ${applied} · 제출 서류 ${submitted}`;
  }
  if (flags.minConfidence === "LOW") return "AI 추출 신뢰도 낮음 — 원본 대조 필요";
  if (flags.isOverdue) return `이수 대기 ${flags.overdueWeeks}주 경과`;
  return null;
}
