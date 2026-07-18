import type { DB } from "../db/db";
import {
  applyEvent,
  type CaseEvent,
  type CaseStatus,
} from "../domain/status";

export interface Employee {
  id: number;
  name: string;
  department: string | null;
  job_role: string | null;
  remaining_points: number | null;
  created_at: string;
}

export interface Case {
  id: number;
  employee_id: number;
  education_type: string;
  education_name: string | null;
  expected_cost: number | null;
  status: CaseStatus;
  reject_reason: string | null;
  prev_case_id: number | null;
  created_at: string;
  approved_at: string | null;
  docs_arrived_at: string | null;
  refunded_at: string | null;
  rejected_at: string | null;
}

export function createEmployee(
  db: DB,
  input: {
    name: string;
    department?: string;
    job_role?: string;
    remaining_points?: number;
  },
): Employee {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO employees (name, department, job_role, remaining_points)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.department ?? null,
      input.job_role ?? null,
      input.remaining_points ?? null,
    );
  return getEmployee(db, Number(lastInsertRowid))!;
}

export function getEmployee(db: DB, id: number): Employee | undefined {
  return db.prepare("SELECT * FROM employees WHERE id = ?").get(id) as
    | Employee
    | undefined;
}

export function createCase(
  db: DB,
  input: {
    employee_id: number;
    education_name?: string;
    expected_cost?: number;
    education_type?: string;
    prev_case_id?: number;
  },
): Case {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO cases (employee_id, education_type, education_name, expected_cost, prev_case_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      input.employee_id,
      input.education_type ?? "AUTONOMOUS",
      input.education_name ?? null,
      input.expected_cost ?? null,
      input.prev_case_id ?? null,
    );
  return getCase(db, Number(lastInsertRowid))!;
}

export function getCase(db: DB, id: number): Case | undefined {
  return db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as
    | Case
    | undefined;
}

/**
 * 신청 건에 이벤트를 적용해 상태를 전이하고 저장한다.
 * 전이 규칙 검증은 domain/status 가 담당 — 불법 전이/사유 누락은 여기서 던진다.
 * @throws {TransitionError}
 */
export function transitionCase(
  db: DB,
  caseId: number,
  event: CaseEvent,
  opts: { reason?: string } = {},
): Case {
  const current = getCase(db, caseId);
  if (!current) throw new Error(`Case ${caseId} 없음`);

  const result = applyEvent(current.status, event, opts);

  db.prepare(
    `UPDATE cases
        SET status = ?,
            ${result.timestampField} = datetime('now'),
            reject_reason = COALESCE(?, reject_reason)
      WHERE id = ?`,
  ).run(result.to, result.reason ?? null, caseId);

  return getCase(db, caseId)!;
}

/**
 * 반려된 건을 재신청한다. 새 Case 를 [심사대기]로 만들고 이전 건과 연결한다.
 * 기획서 §3: "이전 반려 건과 연결" → 상세화면에서 지난 반려 사유 표시에 사용.
 * @throws 이전 건이 반려 상태가 아니면 거부.
 */
export function reapply(
  db: DB,
  rejectedCaseId: number,
  input: { education_name?: string; expected_cost?: number } = {},
): Case {
  const prev = getCase(db, rejectedCaseId);
  if (!prev) throw new Error(`Case ${rejectedCaseId} 없음`);
  if (prev.status !== "REJECTED") {
    throw new Error("반려된 건만 재신청할 수 있습니다.");
  }
  return createCase(db, {
    employee_id: prev.employee_id,
    education_type: prev.education_type,
    education_name: input.education_name ?? prev.education_name ?? undefined,
    expected_cost: input.expected_cost ?? prev.expected_cost ?? undefined,
    prev_case_id: prev.id,
  });
}
