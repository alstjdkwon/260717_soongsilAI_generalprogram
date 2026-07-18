import { describe, expect, it } from "vitest";
import {
  bucketOf,
  computeFlags,
  flagReason,
  type ExtractedFields,
} from "./flags";

const NOW = Date.parse("2026-07-18T09:00:00");

function fields(over: Partial<Record<keyof ExtractedFields, [string | number, "HIGH" | "MID" | "LOW"]>>): ExtractedFields {
  const out: ExtractedFields = {};
  for (const [k, [value, confidence]] of Object.entries(over)) {
    out[k as keyof ExtractedFields] = { value, confidence };
  }
  return out;
}

describe("computeFlags — 신뢰도", () => {
  it("가장 낮은 필드 신뢰도를 취한다", () => {
    const f = computeFlags({
      status: "SCREENING",
      now: NOW,
      application: fields({ name: ["홍길동", "HIGH"], amount: [70000, "LOW"] }),
    });
    expect(f.minConfidence).toBe("LOW");
    expect(f.needsReview).toBe(true);
  });

  it("모두 고신뢰면 검토 불필요", () => {
    const f = computeFlags({
      status: "SCREENING",
      now: NOW,
      application: fields({ name: ["홍길동", "HIGH"], amount: [70000, "HIGH"] }),
    });
    expect(f.minConfidence).toBe("HIGH");
    expect(f.needsReview).toBe(false);
  });
});

describe("computeFlags — 대조 불일치", () => {
  it("금액이 다르면 불일치로 잡는다", () => {
    const f = computeFlags({
      status: "AWAITING_REFUND",
      now: NOW,
      application: fields({ name: ["홍길동", "HIGH"], education_name: ["공공데이터 분석", "HIGH"], amount: [70000, "HIGH"] }),
      completion: fields({ name: ["홍길동", "HIGH"], education_name: ["공공데이터 분석", "HIGH"], amount: [85000, "HIGH"] }),
    });
    expect(f.mismatches).toHaveLength(1);
    expect(f.mismatches[0].field).toBe("amount");
    expect(f.needsReview).toBe(true);
    expect(flagReason(f)).toContain("금액 불일치");
  });

  it("공백·대소문자 차이는 불일치가 아니다", () => {
    const f = computeFlags({
      status: "AWAITING_REFUND",
      now: NOW,
      application: fields({ education_name: ["Data Camp", "HIGH"] }),
      completion: fields({ education_name: ["data camp", "HIGH"] }),
    });
    expect(f.mismatches).toHaveLength(0);
  });

  it("한쪽 서류만 있으면 대조하지 않는다", () => {
    const f = computeFlags({
      status: "SCREENING",
      now: NOW,
      application: fields({ amount: [70000, "HIGH"] }),
    });
    expect(f.mismatches).toHaveLength(0);
  });
});

describe("computeFlags — 경과", () => {
  it("승인 후 기본 4주 넘으면 경과", () => {
    const f = computeFlags({
      status: "IN_PROGRESS",
      now: NOW,
      approvedAt: "2026-06-10 09:00:00",
      application: fields({ name: ["홍길동", "HIGH"] }),
    });
    expect(f.overdueWeeks).toBeGreaterThanOrEqual(4);
    expect(f.isOverdue).toBe(true);
  });

  it("이수 대기가 아니면 경과 계산 안 함", () => {
    const f = computeFlags({
      status: "SCREENING",
      now: NOW,
      approvedAt: "2026-01-01 09:00:00",
      application: fields({ name: ["홍길동", "HIGH"] }),
    });
    expect(f.overdueWeeks).toBe(0);
    expect(f.isOverdue).toBe(false);
  });
});

describe("bucketOf — 카드는 한 곳에만", () => {
  const clean = computeFlags({ status: "SCREENING", now: NOW, application: fields({ name: ["홍길동", "HIGH"] }) });
  const low = computeFlags({ status: "SCREENING", now: NOW, application: fields({ name: ["홍길동", "LOW"] }) });
  const overdue = computeFlags({ status: "IN_PROGRESS", now: NOW, approvedAt: "2026-05-01 09:00:00", application: fields({ name: ["홍길동", "HIGH"] }) });

  it("저신뢰는 심사대기라도 검토 필요로", () => {
    expect(bucketOf("SCREENING", low)).toBe("REVIEW");
  });
  it("깨끗한 심사대기는 처리 대기", () => {
    expect(bucketOf("SCREENING", clean)).toBe("PROCESSING");
  });
  it("경과한 이수대기는 경과 알림", () => {
    expect(bucketOf("IN_PROGRESS", overdue)).toBe("OVERDUE");
  });
  it("완료 건은 큐에 없음", () => {
    expect(bucketOf("DONE", clean)).toBe("NONE");
  });
  it("저신뢰 필드가 남은 완료·반려 건도 큐에 다시 뜨지 않음", () => {
    expect(bucketOf("DONE", low)).toBe("NONE");
    expect(bucketOf("REJECTED", low)).toBe("NONE");
  });
});

describe("riskScore — 저신뢰+방치가 위로", () => {
  it("불일치 > 저신뢰 > 경과 순으로 가중", () => {
    const mismatch = computeFlags({
      status: "AWAITING_REFUND",
      now: NOW,
      application: fields({ amount: [70000, "HIGH"] }),
      completion: fields({ amount: [85000, "HIGH"] }),
    });
    const low = computeFlags({ status: "SCREENING", now: NOW, application: fields({ name: ["x", "LOW"] }) });
    expect(mismatch.riskScore).toBeGreaterThan(low.riskScore);
  });
});
