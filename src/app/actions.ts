"use server";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "../db/serverDb";
import { transitionCase, reapply, syncCaseFromApplicationFields } from "../repo/cases";
import { TransitionError } from "../domain/status";
import {
  ingestFiles,
  attachPending,
  dismissPending,
  resolveApplicationAsExisting,
  resolveApplicationAsNew,
  type IngestResult,
  type DeclaredKind,
} from "../repo/ingest";
import { LlmParser } from "../ai/llmParser";
import type { InputFile } from "../ai/types";
import { getCaseView } from "../repo/queries";
import { generateFitRationale } from "../ai/rationale";
import { getRecentCorrections, saveRationale, saveCorrection } from "../repo/reviews";
import { setOverdueWeeks } from "../repo/settings";

function refresh(caseId: number) {
  revalidatePath("/");
  revalidatePath("/board");
  revalidatePath(`/case/${caseId}`);
}

/**
 * 상세 화면을 연 뒤 결정을 누르기까지 걸린 시간을 기록한다(성과 측정용).
 * 값이 없거나(스크립트 미실행) 비정상이면 조용히 건너뛴다 — 측정은 부수 효과일 뿐,
 * 심사 동작을 막아서는 안 된다.
 */
function recordDecisionTime(id: number, formData: FormData): void {
  const ms = Number(formData.get("elapsedMs"));
  if (!Number.isFinite(ms) || ms <= 0) return;
  getDb().prepare("UPDATE cases SET decision_seconds = ? WHERE id = ?").run(Math.round(ms / 1000), id);
}

export async function approveCase(formData: FormData) {
  const id = Number(formData.get("caseId"));
  transitionCase(getDb(), id, "APPROVE");
  recordDecisionTime(id, formData);
  refresh(id);
}

export async function markDocsArrived(formData: FormData) {
  const id = Number(formData.get("caseId"));
  transitionCase(getDb(), id, "DOCS_ARRIVED");
  refresh(id);
}

export async function refundCase(formData: FormData) {
  const id = Number(formData.get("caseId"));
  transitionCase(getDb(), id, "REFUND");
  // 환급 폼도 같은 심사 화면이라 elapsedMs 가 실려 오지만 일부러 기록하지 않는다.
  // decision_seconds 는 건당 하나뿐이라, 여기서 쓰면 승인/반려 때 잰 판단시간을 덮어쓴다.
  refresh(id);
}

export async function rejectCase(formData: FormData) {
  const id = Number(formData.get("caseId"));
  const reason = String(formData.get("reason") ?? "").trim();
  try {
    transitionCase(getDb(), id, "REJECT", { reason });
  } catch (e) {
    if (e instanceof TransitionError && e.code === "REASON_REQUIRED") {
      redirect(`/case/${id}?err=reason`);
    }
    throw e;
  }
  recordDecisionTime(id, formData);
  refresh(id);
}

export async function reapplyCase(formData: FormData) {
  const id = Number(formData.get("caseId"));
  const next = reapply(getDb(), id);
  refresh(id);
  redirect(`/case/${next.id}`);
}

/**
 * 저신뢰 필드를 원본 대조 후 수정. documents.extracted_fields JSON 을 패치하고,
 * 신청서라면 건·직원 레코드에도 반영한다(교정이 화면·매칭에 실제로 먹히도록).
 */
export async function saveFields(formData: FormData) {
  const caseId = Number(formData.get("caseId"));
  const documentId = Number(formData.get("documentId"));
  const db = getDb();
  const row = db
    .prepare("SELECT kind, extracted_fields FROM documents WHERE id = ?")
    .get(documentId) as { kind: string; extracted_fields: string | null } | undefined;
  if (!row?.extracted_fields) return;

  const fields = JSON.parse(row.extracted_fields) as Record<
    string,
    { value: string | number | null; confidence: string }
  >;
  // 추출에 없던 항목도 폼에서 채울 수 있으므로, 기존 키가 아니라 화면이 내보내는 항목 전체를 훑는다.
  const EDITABLE = ["name", "department", "education_name", "amount", "hours"];
  for (const key of EDITABLE) {
    const raw = formData.get(`f_${key}`);
    if (raw == null) continue;
    const text = String(raw).trim();
    if (text === "") {
      // 빈 칸 = 그 문서에 없는 항목 → 신뢰도 계산·대조에서 빠지도록 키를 지운다.
      delete fields[key];
      continue;
    }
    const numeric = key === "amount" || key === "hours";
    fields[key] = {
      value: numeric ? Number(text.replace(/[^\d.-]/g, "")) || 0 : text,
      confidence: "HIGH", // 사람이 확인·수정한 값은 확정으로 승격
    };
  }
  // extracted_original 은 건드리지 않는다 — AI 원본과 이 교정본을 비교해야 OCR 정확도가 나온다.
  db.prepare("UPDATE documents SET extracted_fields = ? WHERE id = ?").run(
    JSON.stringify(fields),
    documentId,
  );

  if (row.kind === "APPLICATION") {
    const str = (k: string) => {
      const v = fields[k]?.value;
      return v == null ? undefined : String(v).trim() || undefined;
    };
    const amountRaw = fields.amount?.value;
    syncCaseFromApplicationFields(db, caseId, {
      name: str("name"),
      department: str("department"),
      education_name: str("education_name"),
      amount: amountRaw == null ? undefined : Number(amountRaw) || undefined,
    });
  }
  refresh(caseId);
}

export interface UploadState {
  results: IngestResult[];
  error?: string;
}

/**
 * 드롭존에서 올라온 PDF 묶음을 인제스트한다(Upstage OCR + OpenAI).
 * 문서 종류는 어느 드롭존에 넣었는지(declaredKind)로 정해진다 — AI 판별은 검증용.
 * 신청서→새 건 / 이수증→기존 건 매칭. 결과 요약을 돌려주고 큐·칸반을 갱신한다.
 */
export async function uploadDocuments(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
  const declaredKind: DeclaredKind =
    formData.get("declaredKind") === "COMPLETION" ? "COMPLETION" : "APPLICATION";
  const uploaded = formData
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0);
  if (uploaded.length === 0) return { results: [], error: "PDF 파일을 선택하세요." };

  const uploadsDir = join(process.cwd(), "data", "uploads");
  await mkdir(uploadsDir, { recursive: true });

  const files: InputFile[] = [];
  for (const f of uploaded) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    await writeFile(join(uploadsDir, f.name.replace(/[/\\]/g, "_")), bytes);
    files.push({ name: f.name, bytes, mime: f.type || "application/pdf" });
  }

  try {
    const db = getDb();
    const results = await ingestFiles(db, new LlmParser(), files, declaredKind);
    // 새로 만든 심사 건은 직무 부합 근거를 바로 생성한다(현재까지 쌓인 교정을 few-shot 으로).
    const corrections = getRecentCorrections(db, 5);
    for (const r of results) {
      if (r.outcome !== "CREATED_CASE" || !r.caseId) continue;
      const c = getCaseView(db, r.caseId);
      if (!c) continue;
      try {
        const fit = await generateFitRationale(
          { name: c.name, department: c.department, jobRole: c.jobRole, educationName: c.educationName },
          corrections,
        );
        saveRationale(db, r.caseId, fit.rationale, fit.confidence);
      } catch {
        // 근거 생성이 실패해도 업로드·추출 자체는 성공으로 둔다(근거는 상세화면에서 재생성 가능).
      }
    }
    revalidatePath("/");
    revalidatePath("/board");
    return { results };
  } catch (e) {
    return { results: [], error: e instanceof Error ? e.message : "처리 중 오류가 발생했습니다." };
  }
}

/** 심사 화면에서 직무 부합 근거를 (재)생성한다. 쌓인 교정을 few-shot 으로 반영. */
export async function generateRationale(formData: FormData) {
  const caseId = Number(formData.get("caseId"));
  const db = getDb();
  const c = getCaseView(db, caseId);
  if (!c) return;
  const fit = await generateFitRationale(
    { name: c.name, department: c.department, jobRole: c.jobRole, educationName: c.educationName },
    getRecentCorrections(db, 5),
  );
  saveRationale(db, caseId, fit.rationale, fit.confidence);
  refresh(caseId);
}

/**
 * 담당업무를 직접 입력받는다.
 *
 * 조직도에 담당업무가 없는 경우가 많아, 심사하다 비어 있으면 그 자리에서 채우게 한다.
 * 직무 부합 근거의 핵심 입력이라 이게 비면 "담당업무: 미상" 근거가 나온다.
 * (판단보조 2단계에서 결정 시점 스냅샷을 따로 저장해야 한다 — 담당업무가 바뀌면
 *  과거 판례의 의미가 뒤집히기 때문. 여기서는 현재값만 갱신한다.)
 */
export async function saveJobRole(formData: FormData) {
  const caseId = Number(formData.get("caseId"));
  const employeeId = Number(formData.get("employeeId"));
  const jobRole = String(formData.get("jobRole") ?? "").trim();
  getDb().prepare("UPDATE employees SET job_role = ? WHERE id = ?").run(jobRole || null, employeeId);
  refresh(caseId);
}

/** 세영 님이 근거문을 교정해 저장한다. 교정본은 이후 근거 생성의 few-shot 이 된다. */
export async function correctRationale(formData: FormData) {
  const caseId = Number(formData.get("caseId"));
  const text = String(formData.get("correction") ?? "").trim();
  if (!text) return;
  saveCorrection(getDb(), caseId, text);
  refresh(caseId);
}

/** 이수 대기 경과 알림 기준(주)을 조정한다(Phase 6). */
export async function setOverdueSetting(formData: FormData) {
  const weeks = Number(formData.get("weeks"));
  if (Number.isFinite(weeks)) setOverdueWeeks(getDb(), weeks);
  revalidatePath("/");
  revalidatePath("/board");
}

/** 보관 중인 이수증을 세영 님이 고른 건에 첨부한다(Phase 4 후보 선택). */
export async function attachPendingDocument(formData: FormData) {
  const pendingId = Number(formData.get("pendingId"));
  const caseId = Number(formData.get("caseId"));
  attachPending(getDb(), pendingId, caseId);
  revalidatePath("/");
  revalidatePath("/board");
  redirect(`/case/${caseId}`);
}

/** 보관 중인 문서를 버린다(오인식·중복). */
export async function dismissPendingDocument(formData: FormData) {
  const pendingId = Number(formData.get("pendingId"));
  dismissPending(getDb(), pendingId);
  revalidatePath("/");
}

/** 보류된 신청서를 기존 직원의 건으로 확정한다("같은 사람이다" / "중복 아닌 재신청이다"). */
export async function resolvePendingAsExisting(formData: FormData) {
  const pendingId = Number(formData.get("pendingId"));
  const employeeId = Number(formData.get("employeeId"));
  const caseId = resolveApplicationAsExisting(getDb(), pendingId, employeeId);
  revalidatePath("/");
  revalidatePath("/board");
  if (caseId) redirect(`/case/${caseId}`);
}

/** 보류된 신청서를 새 직원의 건으로 확정한다("동명이인이다"). */
export async function resolvePendingAsNew(formData: FormData) {
  const pendingId = Number(formData.get("pendingId"));
  const caseId = resolveApplicationAsNew(getDb(), pendingId);
  revalidatePath("/");
  revalidatePath("/board");
  if (caseId) redirect(`/case/${caseId}`);
}
