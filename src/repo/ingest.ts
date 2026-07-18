import type { DB } from "../db/db";
import type { ExtractedFields } from "../domain/flags";
import type { CaseStatus } from "../domain/status";
import { createCase, createEmployee, getCase, getEmployee, transitionCase } from "./cases";
import {
  educationSimilarity,
  AUTO_MATCH_THRESHOLD,
  CLEAR_GAP,
} from "../domain/similarity";
import type { DocumentParser, InputFile, ParsedDocument } from "../ai/types";

/**
 * 업로드된 파일 묶음을 AI 로 판별·추출해 DB 로 흘려보낸다.
 *
 * 규칙(기획서 §5 Phase 3):
 *  - 신청서(APPLICATION) → 직원(없으면 생성) + 새 심사 건 + 문서
 *  - 이수증(COMPLETION) → 이수 대기(IN_PROGRESS) 건 중 이름·교육명으로 매칭 →
 *    문서 첨부 + [서류 도착] 전이. 단일 확신 매칭만; 애매하면 미매칭으로 리포트(Phase 4에서 후보 선택).
 *  - 판별 실패(UNKNOWN)·미매칭 → DB 를 건드리지 않고 사유만 돌려준다(검토 필요).
 *
 * 파서 인터페이스에만 의존 — 테스트는 FakeParser, 운영은 LlmParser.
 */

export type IngestOutcome =
  | "CREATED_CASE" // 신청서 → 새 건
  | "MATCHED_CASE" // 이수증 → 기존 건 자동 매칭
  | "PENDING_REVIEW" // 이수증인데 후보가 여럿 → 세영 님이 고르도록 보관
  | "UNMATCHED" // 이수증인데 이름이 맞는 이수 대기 건이 아예 없음
  | "UNKNOWN"; // 문서 종류 판별 실패

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
  const name = fieldStr(fields, "name");
  if (!name) return { none: true };

  const rows = db
    .prepare(
      `SELECT c.id, c.education_name, c.status
         FROM cases c
         JOIN employees e ON e.id = c.employee_id
        WHERE c.status = 'IN_PROGRESS'
          AND e.name = ?
          AND NOT EXISTS (
            SELECT 1 FROM documents d WHERE d.case_id = c.id AND d.kind = 'COMPLETION'
          )`,
    )
    .all(name) as unknown as CandidateRow[];

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

/** 애매한 이수증을 보관함에 저장(후보 목록과 함께). 세영 님이 나중에 골라 붙인다. */
function insertPendingDocument(
  db: DB,
  kind: "COMPLETION" | "REPORT",
  parsed: ParsedDocument,
  filePath: string,
  candidateIds: number[],
): number {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO pending_documents (kind, detected_kind, extracted_fields, file_path, candidate_ids)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(kind, parsed.detectedKind, JSON.stringify(parsed.fields), filePath, JSON.stringify(candidateIds));
  return Number(lastInsertRowid);
}

async function ingestOne(
  db: DB,
  parser: DocumentParser,
  file: InputFile,
): Promise<IngestResult> {
  const parsed = await parser.parse(file);
  const base = { file: file.name, detectedKind: parsed.detectedKind };
  const filePath = `uploads/${file.name}`;

  if (parsed.detectedKind === "APPLICATION") {
    const name = fieldStr(parsed.fields, "name") || "(이름 미상)";
    const department = fieldStr(parsed.fields, "department") || undefined;
    const existing = db
      .prepare("SELECT * FROM employees WHERE name = ?")
      .get(name) as { id: number } | undefined;
    const empId = existing?.id ?? createEmployee(db, { name, department }).id;
    // 부서가 비어 있던 기존 직원이면 이번 신청서 값으로 보강.
    if (existing && department && !getEmployee(db, empId)?.department) {
      db.prepare("UPDATE employees SET department = ? WHERE id = ?").run(department, empId);
    }
    const c = createCase(db, {
      employee_id: empId,
      education_name: fieldStr(parsed.fields, "education_name") || undefined,
      expected_cost: fieldNum(parsed.fields, "amount"),
    });
    const docId = insertDocument(db, c.id, "APPLICATION", parsed, filePath);
    return { ...base, outcome: "CREATED_CASE", caseId: c.id, documentId: docId, note: `새 심사 건 생성 — ${name}` };
  }

  if (parsed.detectedKind === "COMPLETION" || parsed.detectedKind === "REPORT") {
    const kind = parsed.detectedKind === "REPORT" ? "REPORT" : "COMPLETION";
    const m = matchCompletion(db, parsed.fields);
    if ("caseId" in m) {
      const docId = insertDocument(db, m.caseId, kind, parsed, filePath);
      transitionCase(db, m.caseId, "DOCS_ARRIVED"); // 이수 대기 → 서류 도착
      return { ...base, outcome: "MATCHED_CASE", caseId: m.caseId, documentId: docId, note: `기존 건에 이수증 첨부 · 서류 도착 처리` };
    }
    if ("candidates" in m) {
      insertPendingDocument(db, kind, parsed, filePath, m.candidates);
      return {
        ...base,
        outcome: "PENDING_REVIEW",
        note: `이수 대기 후보 ${m.candidates.length}건 — 어느 건인지 확인 필요`,
      };
    }
    return { ...base, outcome: "UNMATCHED", note: `맞는 이수 대기 건 없음 — 이름·교육명 확인 필요` };
  }

  return { ...base, outcome: "UNKNOWN", note: "문서 종류를 판별하지 못함 — 수동 확인 필요" };
}

/** 여러 파일을 받은 순서대로 인제스트한다. 이수증은 이미 승인된(IN_PROGRESS) 건에만 매칭되므로 배치 순서에 민감하지 않다. */
export async function ingestFiles(
  db: DB,
  parser: DocumentParser,
  files: InputFile[],
): Promise<IngestResult[]> {
  const out: IngestResult[] = [];
  for (const file of files) {
    out.push(await ingestOne(db, parser, file));
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

/** 보관 중인 이수증을 버린다(오인식·중복 등). */
export function dismissPending(db: DB, pendingId: number): void {
  db.prepare("DELETE FROM pending_documents WHERE id = ?").run(pendingId);
}
