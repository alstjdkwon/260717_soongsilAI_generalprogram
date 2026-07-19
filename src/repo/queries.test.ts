import { describe, it, expect, beforeEach } from "vitest";
import { openDb, type DB } from "../db/db";
import { createEmployee, createCase, transitionCase, reapply } from "./cases";
import { setOverdueWeeks } from "./settings";
import { getQueue, getCaseView } from "./queries";

const WEEK = 7 * 24 * 60 * 60 * 1000;

function approvedCaseWeeksAgo(db: DB, weeks: number): number {
  const emp = createEmployee(db, { name: "경과씨", job_role: "행정" });
  const c = createCase(db, { employee_id: emp.id, education_name: "교육" });
  transitionCase(db, c.id, "APPROVE"); // 이수 대기(IN_PROGRESS)
  // 승인 시각을 weeks 주 전으로 조정.
  const approved = new Date(Date.now() - weeks * WEEK).toISOString().slice(0, 19).replace("T", " ");
  db.prepare("UPDATE cases SET approved_at = ? WHERE id = ?").run(approved, c.id);
  return c.id;
}

describe("경과 기준 설정이 큐에 반영된다", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("기본 4주 기준: 5주 경과 건은 경과 알림 큐에 뜬다", () => {
    const id = approvedCaseWeeksAgo(db, 5);
    const q = getQueue(db);
    expect(q.overdue.map((v) => v.id)).toContain(id);
  });

  it("기준을 8주로 올리면 5주 경과 건은 더 이상 경과 알림이 아니다", () => {
    const id = approvedCaseWeeksAgo(db, 5);
    setOverdueWeeks(db, 8);
    const q = getQueue(db);
    expect(q.overdue.map((v) => v.id)).not.toContain(id);
    expect(getCaseView(db, id)!.flags.isOverdue).toBe(false);
  });
});

describe("재신청 건의 이전 반려 사유", () => {
  let db: DB;
  beforeEach(() => {
    db = openDb();
  });

  it("CaseView.prevRejectReason 에 이전 건의 반려 사유가 실린다", () => {
    const emp = createEmployee(db, { name: "박재신", job_role: "시설" });
    const first = createCase(db, { employee_id: emp.id, education_name: "바리스타 과정" });
    transitionCase(db, first.id, "REJECT", { reason: "직무 관련성 확인 어려움" });
    const next = reapply(db, first.id, { education_name: "시설 안전관리 실무" });

    const view = getCaseView(db, next.id)!;
    expect(view.prevCaseId).toBe(first.id);
    expect(view.prevRejectReason).toBe("직무 관련성 확인 어려움");
  });

  it("재신청이 아닌 건은 prevRejectReason 이 null", () => {
    const emp = createEmployee(db, { name: "김신규", job_role: "총무" });
    const c = createCase(db, { employee_id: emp.id, education_name: "교육" });
    expect(getCaseView(db, c.id)!.prevRejectReason).toBeNull();
  });
});
