import type { DB } from "../db/db";
import type { ExtractedFields } from "../domain/flags";
import type { CaseStatus } from "../domain/status";
import { createCase, createEmployee, findEmployeesByName, getCase, transitionCase } from "./cases";
import {
  educationSimilarity,
  normalizeDept,
  normalizeName,
  AUTO_MATCH_THRESHOLD,
  CLEAR_GAP,
} from "../domain/similarity";
import type { DocumentParser, InputFile, ParsedDocument } from "../ai/types";

/**
 * 업로드된 파일 묶음을 AI 로 추출해 DB 로 흘려보낸다.
 *
 * 문서 종류는 매니저가 업로드 칸으로 지정한다(declaredKind) — AI 판별은 검증용으로만 쓴다.
 * 양식 이름이 기관마다 제각각이라 제목 기반 판별이 실제로 틀린 적이 있어, 사람의 지정을 진실로 삼는다.
 *
 * 규칙:
 *  - 신청서(APPLICATION) → 직원(이름+부서 대조) + 새 심사 건 + 문서.
 *    이름은 같은데 부서가 다르거나(동명이인?), 같은 교육이 이미 진행중이면(중복?) 보관함으로.
 *  - 이수증(COMPLETION) → 이수 대기(IN_PROGRESS) 건 중 이름·교육명으로 매칭 →
 *    문서 첨부 + [서류 도착] 전이. 애매하면 보관함에서 세영 님이 선택.
 *
 * 파서 인터페이스에만 의존 — 테스트는 FakeParser, 운영은 LlmParser.
 */

/** 매니저가 업로드 칸으로 지정하는 문서 종류. */
export type DeclaredKind = "APPLICATION" | "COMPLETION";

/** 자동 처리를 멈추고 사람 판단을 받아야 하는 이유. */
export type HoldReason = "DEPT_MISMATCH" | "DUPLICATE";

export type IngestOutcome =
  | "CREATED_CASE" // 신청서 → 새 건
  | "MATCHED_CASE" // 이수증 → 기존 건 자동 매칭
  | "PENDING_REVIEW"; // 자동 처리가 위험 → 보관함에서 세영 님이 결정

export interface IngestResult {
  file: string;
  detectedKind: ParsedDocument["detectedKind"];
  outcome: IngestOutcome;
  caseId?: number;
  documentId?: number;
  /** 사람이 읽을 처리 결과 한 줄. */
  note: string;
}

function fieldStr(fields: ExtractedFields, key: keyof ExtractedFields): string {
  return String(fields[key]?.value ?? "").trim();
}

function fieldNum(fields: ExtractedFields, key: keyof ExtractedFields): number | undefined {
  const v = fields[key]?.value;
  if (v == null || v === "") return undefined;
  const n = Number(String(v).replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

function insertDocument(
  db: DB,
  caseId: number,
  kind: "APPLICATION" | "COMPLETION" | "REPORT",
  parsed: ParsedDocument,
  filePath: string,
): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO documents (case_id, kind, detected_kind, extracted_fields, file_path)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(caseId, kind, parsed.detectedKind, JSON.stringify(parsed.fields), filePath);
  return Number(lastInsertRowid);
}

interface CandidateRow {
  id: number;
  education_name: string | null;
  status: CaseStatus;
  employee_name: string;
}

type MatchResult =
  | { caseId: number } // 단일 확신 매칭 → 바로 첨부
  | { candidates: number[] } // 후보 여럿(유사도 내림차순) → 세영 님 선택
  | { none: true }; // 이름이 맞는 이수 대기 건이 아예 없음

/**
 * 이수증을 매칭할 후보 건을 찾는다. 이수 대기(IN_PROGRESS)이고 아직 이수증이 없는,
 * 이름이 같은 사람의 건이 후보다.
 *  - 후보 1건 → 자동 매칭(교육명이 어긋나도 첨부하고 대조 단계가 불일치를 잡는다).
 *  - 후보 여럿(동명이인·다중 이수대기) → 교육명 유사도로 점수. 뚜렷한 1등이면 자동,
 *    아니면 후보 목록을 돌려줘 세영 님이 고르게 한다.
 */
function matchCompletion(db: DB, fields: ExtractedFields): MatchResult {
  const name = normalizeName(fieldStr(fields, "name"));
  if (!name) return { none: true };

  // 이름 비교는 정규화 후 JS 에서 — SQL 의 = 는 OCR 이 남긴 공백 차이를 다른 사람으로 본다.
  const rows = (
    db
      .prepare(
        `SELECT c.id, c.education_name, c.status, e.name AS employee_name
           FROM cases c
           JOIN employees e ON e.id = c.employee_id
          WHERE c.status = 'IN_PROGRESS'
            AND NOT EXISTS (
              SELECT 1 FROM documents d WHERE d.case_id = c.id AND d.kind = 'COMPLETION'
            )`,
      )
      .all() as unknown as CandidateRow[]
  ).filter((r) => normalizeName(r.employee_name) === name);

  if (rows.length === 0) return { none: true };
  if (rows.length === 1) return { caseId: rows[0].id };

  // 다중 후보 — 교육명 유사도로 점수 매겨 내림차순 정렬.
  const edu = fieldStr(fields, "education_name");
  const scored = rows
    .map((r) => ({ id: r.id, score: educationSimilarity(edu, r.education_name) }))
    .sort((a, b) => b.score - a.score);

  const [best, second] = scored;
  if (best.score >= AUTO_MATCH_THRESHOLD && best.score - second.score >= CLEAR_GAP) {
    return { caseId: best.id };
  }
  return { candidates: scored.map((s) => s.id) };
}

/**
 * 자동 처리가 위험한 문서를 보관함에 저장(후보와 함께). 세영 님이 나중에 결정한다.
 * @param candidateIds 이수증이면 후보 case id, 부서 불일치면 이름이 같은 employee id, 중복이면 충돌한 case id
 */
function insertPendingDocument(
  db: DB,
  kind: "APPLICATION" | "COMPLETION" | "REPORT",
  parsed: ParsedDocument,
  filePath: string,
  candidateIds: number[],
  declaredKind: DeclaredKind,
  holdReason: HoldReason | null = null,
): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO pending_documents
         (kind, detected_kind, extracted_fields, file_path, candidate_ids, declared_kind, hold_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      kind,
      parsed.detectedKind,
      JSON.stringify(parsed.fields),
      filePath,
      JSON.stringify(candidateIds),
      declaredKind,
      holdReason,
    );
  return Number(lastInsertRowid);
}

/**
 * 중복 신청 검사 대상 상태 — 아직 끝나지 않은 건.
 * 반려(REJECTED)는 정당한 재신청 경로라 제외하고, 완료(DONE)는 다음 해 같은 교육을 다시 들을 수 있어 제외한다.
 */
const ACTIVE_STATUSES = ["SCREENING", "IN_PROGRESS", "AWAITING_REFUND"] as const;

/** 같은 직원이 같은 교육으로 이미 올려둔 진행중 건. 있으면 중복 의심 → 사람이 판단. */
function findDuplicateCase(db: DB, employeeId: number, educationName: string): number | null {
  if (!educationName) return null;
  const rows = db
    .prepare(
      `SELECT id, education_name FROM cases
        WHERE employee_id = ?
          AND status IN (${ACTIVE_STATUSES.map(() => "?").join(", ")})`,
    )
    .all(employeeId, ...ACTIVE_STATUSES) as unknown as { id: number; education_name: string | null }[];

  const hit = rows.find((r) => educationSimilarity(educationName, r.education_name) >= AUTO_MATCH_THRESHOLD);
  return hit?.id ?? null;
}

/**
 * AI 판별이 매니저의 지정과 어긋나면 붙일 경고 문구. 처리는 지정대로 하되 사람이 칸을 다시 보게 한다.
 * (매니저가 칸을 잘못 골랐을 수도, AI 가 틀렸을 수도 있다 — 어느 쪽이든 눈으로 확인할 값어치가 있다.)
 */
function kindWarning(declared: DeclaredKind, detected: ParsedDocument["detectedKind"]): string {
  if (detected === "UNKNOWN") return "";
  if (declared === "APPLICATION" && detected === "APPLICATION") return "";
  if (declared === "COMPLETION" && (detected === "COMPLETION" || detected === "REPORT")) return "";
  const label = detected === "APPLICATION" ? "신청서로" : detected === "REPORT" ? "결과보고서로" : "이수증으로";
  return ` · ⚠ AI는 ${label} 판별 — 넣은 칸이 맞는지 확인하세요`;
}

/** 신청서 처리 — 이름·부서로 직원을 정하고, 중복 신청이 아니면 새 심사 건을 만든다. */
function ingestApplication(
  db: DB,
  parsed: ParsedDocument,
  filePath: string,
  base: { file: string; detectedKind: ParsedDocument["detectedKind"] },
  warn: string,
): IngestResult {
  const extractedName = fieldStr(parsed.fields, "name");
  const name = extractedName || "(이름 미상)";
  const department = fieldStr(parsed.fields, "department") || undefined;
  const educationName = fieldStr(parsed.fields, "education_name");

  // 이름을 못 읽었으면 누구와도 묶지 않는다 — "(이름 미상)" 끼리 붙으면 남남이 한 사람이 된다.
  // 상세 화면에서 원본을 보고 이름을 채우면 그때 실제 직원으로 합쳐진다(syncCaseFromApplicationFields).
  if (!extractedName) {
    const empId = createEmployee(db, { name, department }).id;
    const c = createCase(db, {
      employee_id: empId,
      education_name: educationName || undefined,
      expected_cost: fieldNum(parsed.fields, "amount"),
    });
    const docId = insertDocument(db, c.id, "APPLICATION", parsed, filePath);
    return {
      ...base,
      outcome: "CREATED_CASE",
      caseId: c.id,
      documentId: docId,
      note: `새 심사 건 생성 — 이름 미인식, 원본 보고 채워 주세요${warn}`,
    };
  }

  const sameName = findEmployeesByName(db, name);

  // 이름은 같은데 부서가 다르다 — 동명이인인지 표기 차이인지 기계가 정할 문제가 아니다.
  if (department && sameName.length > 0) {
    const deptMatched = sameName.filter(
      (e) => !e.department || normalizeDept(e.department) === normalizeDept(department),
    );
    if (deptMatched.length === 0) {
      insertPendingDocument(db, "APPLICATION", parsed, filePath, sameName.map((e) => e.id), "APPLICATION", "DEPT_MISMATCH");
      return {
        ...base,
        outcome: "PENDING_REVIEW",
        note: `이름은 같은데 부서가 다릅니다 — 동명이인인지 확인 필요${warn}`,
      };
    }
  }

  const existing = sameName.find(
    (e) => !department || !e.department || normalizeDept(e.department) === normalizeDept(department),
  );

  // 같은 사람이 같은 교육을 이미 신청해 뒀다 — 실수로 두 번 올렸을 수 있다.
  if (existing) {
    const dupCaseId = findDuplicateCase(db, existing.id, educationName);
    if (dupCaseId !== null) {
      insertPendingDocument(db, "APPLICATION", parsed, filePath, [dupCaseId], "APPLICATION", "DUPLICATE");
      return {
        ...base,
        outcome: "PENDING_REVIEW",
        note: `같은 교육의 진행중 신청이 이미 있습니다 — 중복인지 확인 필요${warn}`,
      };
    }
  }

  const empId = existing?.id ?? createEmployee(db, { name, department }).id;
  // 부서가 비어 있던 기존 직원이면 이번 신청서 값으로 보강.
  if (existing && department && !existing.department) {
    db.prepare("UPDATE employees SET department = ? WHERE id = ?").run(department, empId);
  }
  const c = createCase(db, {
    employee_id: empId,
    education_name: educationName || undefined,
    expected_cost: fieldNum(parsed.fields, "amount"),
  });
  const docId = insertDocument(db, c.id, "APPLICATION", parsed, filePath);
  return {
    ...base,
    outcome: "CREATED_CASE",
    caseId: c.id,
    documentId: docId,
    note: `새 심사 건 생성 — ${name}${warn}`,
  };
}

async function ingestOne(
  db: DB,
  parser: DocumentParser,
  file: InputFile,
  declaredKind: DeclaredKind,
): Promise<IngestResult> {
  const parsed = await parser.parse(file);
  const base = { file: file.name, detectedKind: parsed.detectedKind };
  const filePath = `uploads/${file.name}`;
  const warn = kindWarning(declaredKind, parsed.detectedKind);

  if (declaredKind === "APPLICATION") {
    return ingestApplication(db, parsed, filePath, base, warn);
  }

  // 이수증 칸 — AI 가 결과보고서로 봤으면 그 종류로 저장하되 매칭 경로는 같다.
  const kind = parsed.detectedKind === "REPORT" ? "REPORT" : "COMPLETION";
  const m = matchCompletion(db, parsed.fields);
  if ("caseId" in m) {
    const docId = insertDocument(db, m.caseId, kind, parsed, filePath);
    transitionCase(db, m.caseId, "DOCS_ARRIVED"); // 이수 대기 → 서류 도착
    return { ...base, outcome: "MATCHED_CASE", caseId: m.caseId, documentId: docId, note: `기존 건에 이수증 첨부 · 서류 도착 처리${warn}` };
  }
  if ("candidates" in m) {
    insertPendingDocument(db, kind, parsed, filePath, m.candidates, declaredKind);
    return {
      ...base,
      outcome: "PENDING_REVIEW",
      note: `이수 대기 후보 ${m.candidates.length}건 — 어느 건인지 확인 필요${warn}`,
    };
  }
  // 이름이 맞는 건이 없어도 버리지 않는다 — 보관함에 담아 세영 님이 직접 붙일 수 있게.
  insertPendingDocument(db, kind, parsed, filePath, [], declaredKind);
  return {
    ...base,
    outcome: "PENDING_REVIEW",
    note: `맞는 이수 대기 건 없음 — 보관함에서 직접 골라 붙이세요${warn}`,
  };
}

/**
 * 한 업로드 칸에서 올라온 파일들을 받은 순서대로 인제스트한다.
 * 이수증은 이미 승인된(IN_PROGRESS) 건에만 매칭되므로 배치 순서에 민감하지 않다.
 */
export async function ingestFiles(
  db: DB,
  parser: DocumentParser,
  files: InputFile[],
  declaredKind: DeclaredKind,
): Promise<IngestResult[]> {
  const out: IngestResult[] = [];
  for (const file of files) {
    out.push(await ingestOne(db, parser, file, declaredKind));
  }
  return out;
}

interface PendingRow {
  id: number;
  kind: string;
  detected_kind: string | null;
  extracted_fields: string | null;
  file_path: string | null;
}

/**
 * 보관 중이던 이수증을 세영 님이 고른 건에 첨부한다.
 * documents 로 옮기고, 그 건이 이수 대기면 서류 도착으로 전이한 뒤 보관 행을 지운다.
 * @returns 새 document id, 대상이 없으면 null
 */
export function attachPending(db: DB, pendingId: number, caseId: number): number | null {
  const p = db
    .prepare("SELECT id, kind, detected_kind, extracted_fields, file_path FROM pending_documents WHERE id = ?")
    .get(pendingId) as PendingRow | undefined;
  if (!p) return null;

  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO documents (case_id, kind, detected_kind, extracted_fields, file_path)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(caseId, p.kind, p.detected_kind, p.extracted_fields, p.file_path);

  const c = getCase(db, caseId);
  if (c?.status === "IN_PROGRESS") transitionCase(db, caseId, "DOCS_ARRIVED");

  db.prepare("DELETE FROM pending_documents WHERE id = ?").run(pendingId);
  return Number(lastInsertRowid);
}

/** 보관 중인 문서를 버린다(오인식·중복 등). */
export function dismissPending(db: DB, pendingId: number): void {
  db.prepare("DELETE FROM pending_documents WHERE id = ?").run(pendingId);
}

/** 보관 중인 신청서로 심사 건을 만든다. employeeId 를 주면 그 직원에, 없으면 새 직원을 만들어 붙인다. */
function createCaseFromPending(db: DB, pendingId: number, employeeId: number | null): number | null {
  const p = db
    .prepare("SELECT id, kind, detected_kind, extracted_fields, file_path FROM pending_documents WHERE id = ?")
    .get(pendingId) as PendingRow | undefined;
  if (!p) return null;

  const fields = JSON.parse(p.extracted_fields ?? "{}") as ExtractedFields;
  const empId =
    employeeId ??
    createEmployee(db, {
      name: fieldStr(fields, "name") || "(이름 미상)",
      department: fieldStr(fields, "department") || undefined,
    }).id;

  const c = createCase(db, {
    employee_id: empId,
    education_name: fieldStr(fields, "education_name") || undefined,
    expected_cost: fieldNum(fields, "amount"),
  });
  db.prepare(
    `INSERT INTO documents (case_id, kind, detected_kind, extracted_fields, file_path)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(c.id, p.kind, p.detected_kind, p.extracted_fields, p.file_path);

  db.prepare("DELETE FROM pending_documents WHERE id = ?").run(pendingId);
  return c.id;
}

/** "같은 사람이다" — 보류된 신청서를 기존 직원에 붙여 심사 건을 만든다. */
export function resolveApplicationAsExisting(db: DB, pendingId: number, employeeId: number): number | null {
  return createCaseFromPending(db, pendingId, employeeId);
}

/** "동명이인이다 / 중복이 아니다" — 보류된 신청서로 새 직원과 심사 건을 만든다. */
export function resolveApplicationAsNew(db: DB, pendingId: number): number | null {
  return createCaseFromPending(db, pendingId, null);
}
