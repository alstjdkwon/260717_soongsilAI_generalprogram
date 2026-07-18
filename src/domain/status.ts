/**
 * 신청 건(Case)의 상태 모델과 전이 규칙.
 *
 * 상태 흐름 (기획서 §3):
 *   심사대기 ──승인──> 이수대기 ──서류도착──> 환급대기 ──환급──> 완료
 *      │                                         │
 *      └──반려──> 반려 <───────반려──────────────┘
 *
 * 반려는 사유 필수. 재신청은 상태 전이가 아니라 새 Case 생성(→ repo/cases.ts).
 * 이 모듈은 DB에 의존하지 않는 순수 로직이라 단위 테스트로 규칙을 고정한다.
 */

export const CASE_STATUS = {
  SCREENING: "심사대기",
  IN_PROGRESS: "이수대기",
  AWAITING_REFUND: "환급대기",
  DONE: "완료",
  REJECTED: "반려",
} as const;

export type CaseStatus = keyof typeof CASE_STATUS;

export const CASE_EVENT = {
  APPROVE: "승인",
  REJECT: "반려",
  DOCS_ARRIVED: "서류도착",
  REFUND: "환급",
} as const;

export type CaseEvent = keyof typeof CASE_EVENT;

/** 이벤트별로 기록할 타임스탬프 컬럼 (cases 테이블). */
export type TimestampField =
  | "approved_at"
  | "docs_arrived_at"
  | "refunded_at"
  | "rejected_at";

interface TransitionRule {
  to: CaseStatus;
  timestampField: TimestampField;
  /** 반려처럼 사유(reason)가 반드시 필요한 전이. */
  requiresReason?: boolean;
}

/** 허용된 (상태, 이벤트) → 결과. 여기 없는 조합은 전부 불법 전이. */
const TRANSITIONS: Partial<Record<CaseStatus, Partial<Record<CaseEvent, TransitionRule>>>> = {
  SCREENING: {
    APPROVE: { to: "IN_PROGRESS", timestampField: "approved_at" },
    REJECT: { to: "REJECTED", timestampField: "rejected_at", requiresReason: true },
  },
  IN_PROGRESS: {
    DOCS_ARRIVED: { to: "AWAITING_REFUND", timestampField: "docs_arrived_at" },
  },
  AWAITING_REFUND: {
    REFUND: { to: "DONE", timestampField: "refunded_at" },
    // 환급 검토에서 대조 불일치 등으로 최종 반려 가능 (기획서 §4 ⑥)
    REJECT: { to: "REJECTED", timestampField: "rejected_at", requiresReason: true },
  },
};

export type TransitionErrorCode = "INVALID_TRANSITION" | "REASON_REQUIRED";

export class TransitionError extends Error {
  constructor(
    public readonly code: TransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TransitionError";
  }
}

export interface TransitionResult {
  to: CaseStatus;
  timestampField: TimestampField;
  /** 반려 사유. 반려 전이일 때만 채워진다. */
  reason?: string;
}

/**
 * 상태 전이를 검증하고 결과를 계산한다. 상태를 저장하지 않는다.
 * @throws {TransitionError} 불법 전이이거나, 반려인데 사유가 비었을 때.
 */
export function applyEvent(
  from: CaseStatus,
  event: CaseEvent,
  opts: { reason?: string } = {},
): TransitionResult {
  const rule = TRANSITIONS[from]?.[event];
  if (!rule) {
    throw new TransitionError(
      "INVALID_TRANSITION",
      `'${CASE_STATUS[from]}' 상태에서는 '${CASE_EVENT[event]}' 할 수 없습니다.`,
    );
  }

  if (rule.requiresReason) {
    const reason = opts.reason?.trim();
    if (!reason) {
      throw new TransitionError(
        "REASON_REQUIRED",
        `'${CASE_EVENT[event]}' 시 사유는 필수입니다.`,
      );
    }
    return { to: rule.to, timestampField: rule.timestampField, reason };
  }

  return { to: rule.to, timestampField: rule.timestampField };
}

/** 해당 상태가 더 이상 전이할 수 없는 종료 상태인지. */
export function isTerminal(status: CaseStatus): boolean {
  return TRANSITIONS[status] === undefined;
}
