import type { DB } from "../db/db";
import {
  applyEvent,
  type CaseEvent,
  type CaseStatus,
} from "../domain/status";
import { normalizeName } from "../domain/similarity";

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

/**
 * 이름이 같은 직원을 모두 찾는다(동명이인이면 여럿).
 * 비교는 정규화 후 JS 에서 한다 — SQL 의 = 는 OCR 이 남긴 공백 차이를 다른 사람으로 보기 때문.
 * 교직원 수가 적은 내부 도구라 전량 스캔으로 충분하고, 정규화 규칙을 한 곳에 모을 수 있다.
 */
export function findEmployeesByName(db: DB, name: string): Employee[] {
  const target = normalizeName(name);
  if (!target) return [];
  const all = db.prepare("SELECT * FROM employees").all() as unknown as Employee[];
  return all.filter((e) => normalizeName(e.name) === target);
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

export interface CorrectedApplicationFields {
  name?: string;
  department?: string;
  education_name?: string;
  amount?: number;
}

/**
 * 신청서 추출 필드를 사람이 교정했을 때 건·직원 레코드에도 반영한다.
 *
 * documents.extracted_fields(JSON) 만 고치면 화면·매칭이 실제로 쓰는 레코드는 그대로라
 * 교정이 무의미해진다(이수증 매칭은 employees.name 을 본다).
 *  - 이름이 바뀌면: 같은 이름 직원이 있으면 그 직원으로 건을 옮기고,
 *    없으면 이 건뿐인 직원은 개명, 다른 건도 가진 직원이면 새 직원을 만들어 옮긴다.
 *  - 건이 하나도 안 남은 이전 직원(업로드가 만든 임시 레코드)은 지운다.
 */
export function syncCaseFromApplicationFields(
  db: DB,
  caseId: number,
  fields: CorrectedApplicationFields,
): void {
  const c = getCase(db, caseId);
  if (!c) return;

  const education = fields.education_name?.trim() || null;
  const amount = Number.isFinite(fields.amount) ? fields.amount! : null;
  if (education !== null || amount !== null) {
    db.prepare(
      "UPDATE cases SET education_name = COALESCE(?, education_name), expected_cost = COALESCE(?, expected_cost) WHERE id = ?",
    ).run(education, amount, caseId);
  }

  const department = fields.department?.trim() || null;
  const name = fields.name?.trim() || null;
  const prevEmployeeId = c.employee_id;

  if (!name) {
    if (department) db.prepare("UPDATE employees SET department = ? WHERE id = ?").run(department, prevEmployeeId);
    return;
  }

  const current = getEmployee(db, prevEmployeeId);
  if (current && normalizeName(current.name) === normalizeName(name)) {
    if (department) db.prepare("UPDATE employees SET department = ? WHERE id = ?").run(department, prevEmployeeId);
    return;
  }

  const existing = findEmployeesByName(db, name).find((e) => e.id !== prevEmployeeId);
  if (existing) {
    db.prepare("UPDATE cases SET employee_id = ? WHERE id = ?").run(existing.id, caseId);
    if (department) {
      db.prepare("UPDATE employees SET department = COALESCE(department, ?) WHERE id = ?").run(department, existing.id);
    }
  } else {
    const others = db
      .prepare("SELECT COUNT(*) AS n FROM cases WHERE employee_id = ? AND id <> ?")
      .get(prevEmployeeId, caseId) as { n: number };
    if (others.n === 0) {
      // 이 건 하나뿐인 직원이면 그대로 개명 — 옮길 필요 없음.
      db.prepare("UPDATE employees SET name = ?, department = COALESCE(?, department) WHERE id = ?").run(name, department, prevEmployeeId);
      return;
    }
    const created = createEmployee(db, { name, department: department ?? undefined });
    db.prepare("UPDATE cases SET employee_id = ? WHERE id = ?").run(created.id, caseId);
  }

  const left = db.prepare("SELECT COUNT(*) AS n FROM cases WHERE employee_id = ?").get(prevEmployeeId) as { n: number };
  if (left.n === 0) db.prepare("DELETE FROM employees WHERE id = ?").run(prevEmployeeId);
}
