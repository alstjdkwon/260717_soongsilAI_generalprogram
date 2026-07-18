import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/db";
import {
  createEmployee,
  createCase,
  getCase,
  transitionCase,
  reapply,
} from "./cases";
import { TransitionError } from "../domain/status";

let db: DB;

beforeEach(() => {
  db = openDb(); // 인메모리
});

function seedCase() {
  const emp = createEmployee(db, {
    name: "홍길동",
    department: "총무팀",
    job_role: "교육훈련 담당",
    remaining_points: 100,
  });
  return createCase(db, {
    employee_id: emp.id,
    education_name: "테스트교육1",
    expected_cost: 70000,
  });
}

describe("생성", () => {
  it("새 건은 심사대기 · 자율교육 기본값으로 생성된다", () => {
    const c = seedCase();
    expect(c.status).toBe("SCREENING");
    expect(c.education_type).toBe("AUTONOMOUS");
    expect(c.created_at).toBeTruthy();
    expect(c.approved_at).toBeNull();
  });
});

describe("전이 저장", () => {
  it("승인하면 상태와 approved_at 이 저장된다", () => {
    const c = seedCase();
    const after = transitionCase(db, c.id, "APPROVE");
    expect(after.status).toBe("IN_PROGRESS");
    expect(after.approved_at).toBeTruthy();
  });

  it("전체 해피패스가 DB에 반영된다", () => {
    const c = seedCase();
    transitionCase(db, c.id, "APPROVE");
    transitionCase(db, c.id, "DOCS_ARRIVED");
    const done = transitionCase(db, c.id, "REFUND");
    expect(done.status).toBe("DONE");
    expect(done.approved_at).toBeTruthy();
    expect(done.docs_arrived_at).toBeTruthy();
    expect(done.refunded_at).toBeTruthy();
  });

  it("반려 사유가 저장된다", () => {
    const c = seedCase();
    const after = transitionCase(db, c.id, "REJECT", { reason: "직무 무관" });
    expect(after.status).toBe("REJECTED");
    expect(after.reject_reason).toBe("직무 무관");
    expect(after.rejected_at).toBeTruthy();
  });

  it("불법 전이는 던지고 상태를 바꾸지 않는다", () => {
    const c = seedCase();
    expect(() => transitionCase(db, c.id, "REFUND")).toThrowError(
      TransitionError,
    );
    expect(getCase(db, c.id)!.status).toBe("SCREENING");
  });

  it("반려 사유 누락 시 던지고 상태를 바꾸지 않는다", () => {
    const c = seedCase();
    expect(() => transitionCase(db, c.id, "REJECT")).toThrowError(
      TransitionError,
    );
    expect(getCase(db, c.id)!.status).toBe("SCREENING");
  });
});

describe("재신청", () => {
  it("반려 건을 재신청하면 새 심사대기 건이 이전 건과 연결된다", () => {
    const c = seedCase();
    transitionCase(db, c.id, "REJECT", { reason: "예산 초과" });
    const re = reapply(db, c.id);
    expect(re.id).not.toBe(c.id);
    expect(re.status).toBe("SCREENING");
    expect(re.prev_case_id).toBe(c.id);
    expect(re.education_name).toBe("테스트교육1"); // 이전 값 승계
  });

  it("반려되지 않은 건은 재신청할 수 없다", () => {
    const c = seedCase();
    expect(() => reapply(db, c.id)).toThrowError(/반려된 건만/);
  });
});
