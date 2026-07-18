"use server";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getDb } from "../db/serverDb";
import { transitionCase, reapply } from "../repo/cases";
import { TransitionError } from "../domain/status";
import { ingestFiles, attachPending, dismissPending, type IngestResult } from "../repo/ingest";
import { LlmParser } from "../ai/llmParser";
import type { InputFile } from "../ai/types";
import { getCaseView } from "../repo/queries";
import { generateFitRationale } from "../ai/rationale";
import { getRecentCorrections, saveRationale, saveCorrection } from "../repo/reviews";

function refresh(caseId: number) {
  revalidatePath("/");
  revalidatePath("/board");
  revalidatePath(`/case/${caseId}`);
}

export async function approveCase(formData: FormData) {
  const id = Number(formData.get("caseId"));
  transitionCase(getDb(), id, "APPROVE");
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
  refresh(id);
}

export async function reapplyCase(formData: FormData) {
  const id = Number(formData.get("caseId"));
  const next = reapply(getDb(), id);
  refresh(id);
  redirect(`/case/${next.id}`);
}

/** 저신뢰 필드를 원본 대조 후 수정. documents.extracted_fields JSON 을 패치한다. */
export async function saveFields(formData: FormData) {
  const caseId = Number(formData.get("caseId"));
  const documentId = Number(formData.get("documentId"));
  const db = getDb();
  const row = db
    .prepare("SELECT extracted_fields FROM documents WHERE id = ?")
    .get(documentId) as { extracted_fields: string | null } | undefined;
  if (!row?.extracted_fields) return;

  const fields = JSON.parse(row.extracted_fields) as Record<
    string,
    { value: string | number | null; confidence: string }
  >;
  for (const key of Object.keys(fields)) {
    const raw = formData.get(`f_${key}`);
    if (raw == null) continue;
    const text = String(raw).trim();
    const numeric = key === "amount" || key === "hours";
    fields[key] = {
      value: numeric ? Number(text.replace(/[^\d.-]/g, "")) || 0 : text,
      confidence: "HIGH", // 사람이 확인·수정한 값은 확정으로 승격
    };
  }
  db.prepare("UPDATE documents SET extracted_fields = ? WHERE id = ?").run(
    JSON.stringify(fields),
    documentId,
  );
  refresh(caseId);
}

export interface UploadState {
  results: IngestResult[];
  error?: string;
}

/**
 * 드롭존에서 올라온 PDF 묶음을 인제스트한다(Upstage OCR + OpenAI).
 * 신청서→새 건 / 이수증→기존 건 매칭. 결과 요약을 돌려주고 큐·칸반을 갱신한다.
 */
export async function uploadDocuments(
  _prev: UploadState,
  formData: FormData,
): Promise<UploadState> {
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
    const results = await ingestFiles(db, new LlmParser(), files);
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

/** 세영 님이 근거문을 교정해 저장한다. 교정본은 이후 근거 생성의 few-shot 이 된다. */
export async function correctRationale(formData: FormData) {
  const caseId = Number(formData.get("caseId"));
  const text = String(formData.get("correction") ?? "").trim();
  if (!text) return;
  saveCorrection(getDb(), caseId, text);
  refresh(caseId);
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

/** 보관 중인 이수증을 버린다(오인식·중복). */
export async function dismissPendingDocument(formData: FormData) {
  const pendingId = Number(formData.get("pendingId"));
  dismissPending(getDb(), pendingId);
  revalidatePath("/");
}
