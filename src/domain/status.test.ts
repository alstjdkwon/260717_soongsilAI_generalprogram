import { describe, it, expect } from "vitest";
import {
  applyEvent,
  isTerminal,
  TransitionError,
  type CaseStatus,
  type CaseEvent,
} from "./status";

describe("applyEvent — 정상 전이", () => {
  it("심사대기 + 승인 → 이수대기", () => {
    const r = applyEvent("SCREENING", "APPROVE");
    expect(r.to).toBe("IN_PROGRESS");
    expect(r.timestampField).toBe("approved_at");
    expect(r.reason).toBeUndefined();
  });

  it("이수대기 + 서류도착 → 환급대기", () => {
    const r = applyEvent("IN_PROGRESS", "DOCS_ARRIVED");
    expect(r.to).toBe("AWAITING_REFUND");
    expect(r.timestampField).toBe("docs_arrived_at");
  });

  it("환급대기 + 환급 → 완료", () => {
    const r = applyEvent("AWAITING_REFUND", "REFUND");
    expect(r.to).toBe("DONE");
    expect(r.timestampField).toBe("refunded_at");
  });

  it("전체 해피패스: 심사대기 → 이수대기 → 환급대기 → 완료", () => {
    let s: CaseStatus = "SCREENING";
    s = applyEvent(s, "APPROVE").to;
    s = applyEvent(s, "DOCS_ARRIVED").to;
    s = applyEvent(s, "REFUND").to;
    expect(s).toBe("DONE");
  });
});

describe("applyEvent — 반려 (사유 필수)", () => {
  it("심사대기 + 반려(사유 있음) → 반려", () => {
    const r = applyEvent("SCREENING", "REJECT", { reason: "직무 무관" });
    expect(r.to).toBe("REJECTED");
    expect(r.timestampField).toBe("rejected_at");
    expect(r.reason).toBe("직무 무관");
  });

  it("환급대기에서도 반려 가능 (대조 불일치)", () => {
    const r = applyEvent("AWAITING_REFUND", "REJECT", { reason: "금액 불일치" });
    expect(r.to).toBe("REJECTED");
  });

  it("반려인데 사유가 비면 REASON_REQUIRED", () => {
    expect(() => applyEvent("SCREENING", "REJECT")).toThrowError(TransitionError);
    try {
      applyEvent("SCREENING", "REJECT", { reason: "   " });
      expect.unreachable("사유 공백은 거부되어야 함");
    } catch (e) {
      expect(e).toBeInstanceOf(TransitionError);
      expect((e as TransitionError).code).toBe("REASON_REQUIRED");
    }
  });

  it("사유 앞뒤 공백은 trim 되어 저장된다", () => {
    const r = applyEvent("SCREENING", "REJECT", { reason: "  예산 초과  " });
    expect(r.reason).toBe("예산 초과");
  });
});

describe("applyEvent — 불법 전이 차단", () => {
  const illegal: Array<[CaseStatus, CaseEvent]> = [
    ["SCREENING", "DOCS_ARRIVED"],
    ["SCREENING", "REFUND"],
    ["IN_PROGRESS", "APPROVE"],
    ["IN_PROGRESS", "REFUND"],
    ["AWAITING_REFUND", "APPROVE"],
    ["AWAITING_REFUND", "DOCS_ARRIVED"],
    ["DONE", "APPROVE"],
    ["DONE", "REFUND"],
    ["REJECTED", "APPROVE"],
    ["REJECTED", "REJECT"],
  ];

  it.each(illegal)("%s 상태에서 %s 는 INVALID_TRANSITION", (from, event) => {
    try {
      applyEvent(from, event, { reason: "x" });
      expect.unreachable("불법 전이는 예외여야 함");
    } catch (e) {
      expect(e).toBeInstanceOf(TransitionError);
      expect((e as TransitionError).code).toBe("INVALID_TRANSITION");
    }
  });
});

describe("isTerminal", () => {
  it("완료·반려는 종료 상태", () => {
    expect(isTerminal("DONE")).toBe(true);
    expect(isTerminal("REJECTED")).toBe(true);
  });
  it("진행 중 상태는 종료가 아님", () => {
    expect(isTerminal("SCREENING")).toBe(false);
    expect(isTerminal("IN_PROGRESS")).toBe(false);
    expect(isTerminal("AWAITING_REFUND")).toBe(false);
  });
});
