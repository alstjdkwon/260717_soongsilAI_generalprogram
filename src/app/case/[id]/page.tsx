import { existsSync } from "node:fs";
import { join } from "node:path";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../db/serverDb";
import { getCaseView, type CaseView } from "../../../repo/queries";
import type { ExtractedFields } from "../../../domain/flags";
import { won, shortDate } from "../../_components/format";
import { GlobalNav } from "../../_components/Nav";
import { RationaleSubmit } from "../../_components/RationaleSubmit";
import { DecisionTimer } from "../../_components/DecisionTimer";
import {
  approveCase,
  markDocsArrived,
  refundCase,
  rejectCase,
  reapplyCase,
  saveFields,
  generateRationale,
  correctRationale,
} from "../../actions";

export const dynamic = "force-dynamic";

const FIELD_ORDER: (keyof ExtractedFields)[] = ["name", "department", "education_name", "amount", "hours"];
const FIELD_LABEL: Record<keyof ExtractedFields, string> = {
  name: "이름",
  department: "부서",
  education_name: "교육명",
  amount: "금액",
  hours: "수료시간",
};

function fmtVal(key: keyof ExtractedFields, value: string | number | null): string {
  if (value == null || value === "") return "—";
  if (key === "amount") return won(Number(value));
  if (key === "hours") return `${value}시간`;
  return String(value);
}

const KIND_LABEL: Record<string, string> = {
  APPLICATION: "자율교육 신청서",
  COMPLETION: "이수증",
  REPORT: "결과보고서",
};

/** 원본 파일이 실제로 디스크에 있는지 — 시드 문서는 없으므로 팩시밀리로 폴백한다. */
function hasFile(filePath: string | null): boolean {
  if (!filePath) return false;
  return existsSync(join(process.cwd(), "data", filePath));
}

export default async function CaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string; doc?: string }>;
}) {
  const { id } = await params;
  const { err, doc } = await searchParams;
  const db = getDb();
  const c = getCaseView(db, Number(id));
  if (!c) notFound();

  const prev = c.prevCaseId
    ? (db.prepare("SELECT education_name, reject_reason FROM cases WHERE id = ?").get(c.prevCaseId) as
        | { education_name: string | null; reject_reason: string | null }
        | undefined)
    : undefined;

  const showCompare = c.status === "AWAITING_REFUND" && c.completion;

  // 어떤 문서를 펼쳐 볼지 — 지정이 없으면 지금 단계에서 볼 문서를 기본값으로.
  const docs = c.documents;
  const preferredKind = showCompare ? "COMPLETION" : "APPLICATION";
  const selected =
    docs.find((d) => String(d.id) === doc) ??
    docs.find((d) => d.kind === preferredKind) ??
    docs[0];

  return (
    <>
      <GlobalNav />
      <main className="wrap detail">
        <Link href="/" className="link-back">← 할일 큐로</Link>

        <div className="detail-head">
          <div>
            <div className="who" style={{ marginBottom: 6 }}>
              <span className={`sdot ${c.status}`} aria-hidden />
              <h1 className="t-display-lg" style={{ margin: 0 }}>{c.name}</h1>
              <span className="dept muted">{c.department}</span>
            </div>
            <p className="t-lead" style={{ margin: 0 }}>{c.educationName}</p>
          </div>
          <div className="meta-chips">
            <span className="chip">{c.statusLabel}</span>
            {c.remainingPoints != null && <span className="chip tabnum">잔여 <b>{c.remainingPoints}P</b></span>}
            <span className="chip">접수 <b>{shortDate(c.createdAt)}</b></span>
            {c.approvedAt && <span className="chip">승인 <b>{shortDate(c.approvedAt)}</b></span>}
          </div>
        </div>

        <StatusBanner c={c} />

        {prev && (
          <div className="prev-reject">
            재신청 건입니다. 이전 「{prev.education_name}」 반려 사유: {prev.reject_reason ?? "사유 없음"}
          </div>
        )}

        <div className="split">
          {/* 좌: 업로드한 원본 PDF (없으면 팩시밀리) */}
          <div className="paper">
            <div className="paper-bar">
              <div className="doc-tabs">
                {docs.map((d) => (
                  <Link
                    key={d.id}
                    href={`/case/${c.id}?doc=${d.id}`}
                    className={`doc-tab${selected?.id === d.id ? " active" : ""}`}
                  >
                    {KIND_LABEL[d.kind] ?? d.kind}
                  </Link>
                ))}
                {docs.length === 0 && <span className="t-caption-strong">문서 없음</span>}
              </div>
              {selected && hasFile(selected.filePath) && (
                <a
                  href={`/api/documents/${selected.id}/file`}
                  target="_blank"
                  rel="noreferrer"
                  className="t-fine doc-open"
                >
                  새 탭에서 열기 ↗
                </a>
              )}
            </div>

            {selected && hasFile(selected.filePath) ? (
              <iframe
                src={`/api/documents/${selected.id}/file`}
                className="paper-pdf"
                title={`${KIND_LABEL[selected.kind] ?? selected.kind} 원본`}
              />
            ) : (
              <Facsimile c={c} fields={selected?.fields} kindLabel={selected ? KIND_LABEL[selected.kind] ?? selected.kind : "문서"} />
            )}
          </div>

          {/* 우: 추출 필드 수정 / 대조 / 근거 */}
          <div>
            {selected ? (
              <FieldsForm
                caseId={c.id}
                documentId={selected.id}
                kindLabel={KIND_LABEL[selected.kind] ?? selected.kind}
                fields={selected.fields}
              />
            ) : (
              <div className="panel"><p className="muted t-caption">이 건에는 업로드된 문서가 없습니다.</p></div>
            )}

            {showCompare && <CompareTable c={c} />}

            {c.status === "SCREENING" && <FitRationalePanel c={c} />}

            <ActionBar c={c} reasonError={err === "reason"} />
          </div>
        </div>
      </main>
    </>
  );
}

function StatusBanner({ c }: { c: CaseView }) {
  // 종료 상태를 먼저 — 완료 건에 "확인 필요"가 뜨지 않도록.
  if (c.status === "DONE") {
    return <div className="banner ok"><b>완료</b><span>환급까지 마무리된 건입니다.</span></div>;
  }
  if (c.status === "REJECTED") {
    return <div className="banner warn"><b>반려됨</b><span>{c.rejectReason}</span></div>;
  }
  if (c.reason) {
    const warn = !c.flags.needsReview;
    return (
      <div className={`banner${warn ? " warn" : ""}`}>
        <b>확인 필요</b>
        <span>{c.reason}</span>
      </div>
    );
  }
  return null;
}

/** 원본 파일이 없는 문서(시드)용 — 추출값으로 문서 모양을 흉내 낸다. */
function Facsimile({
  c,
  fields,
  kindLabel,
}: {
  c: CaseView;
  fields?: ExtractedFields;
  kindLabel: string;
}) {
  return (
    <div className="paper-body">
      <p className="paper-title">{kindLabel}</p>
      <p className="paper-sub">숭실대학교 · 교직원 자율교육</p>
      <dl style={{ margin: 0 }}>
        {FIELD_ORDER.map((k) => {
          const f = fields?.[k];
          if (!f) return null;
          return (
            <div className="paper-row" key={k}>
              <dt>{FIELD_LABEL[k]}</dt>
              <dd>{fmtVal(k, f.value)}</dd>
            </div>
          );
        })}
      </dl>
      <p className="paper-stamp">원본 파일 없음 · 임의 생성 데이터 · {shortDate(c.docsArrivedAt ?? c.createdAt)}</p>
    </div>
  );
}

/**
 * 추출 필드 확인·수정.
 * OCR 이 못 읽어 빠진 항목도 빈 칸으로 내보내, 왼쪽 원본을 보고 직접 채울 수 있게 한다.
 * 빈 칸으로 저장하면 "그 문서에 없는 항목"으로 처리된다.
 */
function FieldsForm({
  caseId,
  documentId,
  kindLabel,
  fields,
}: {
  caseId: number;
  documentId: number;
  kindLabel: string;
  fields: ExtractedFields;
}) {
  return (
    <form action={saveFields} className="panel">
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="documentId" value={documentId} />
      <h3 className="t-body-strong">
        {kindLabel} 추출 필드{" "}
        <span className="muted t-fine">· 왼쪽 원본과 대조해 고치거나 빠진 값을 직접 입력하세요</span>
      </h3>
      {FIELD_ORDER.map((k) => {
        const f = fields[k];
        const missing = !f || f.value == null || f.value === "";
        const low = f?.confidence === "LOW";
        return (
          <div className={`field${low || missing ? " low" : ""}`} key={k}>
            <label htmlFor={`f_${k}`}>{FIELD_LABEL[k]}</label>
            <input
              id={`f_${k}`}
              name={`f_${k}`}
              defaultValue={f?.value == null ? "" : String(f.value)}
              placeholder={missing ? "미인식 — 원본 보고 입력" : undefined}
            />
            {f ? (
              <span className={`conf ${f.confidence}`}>{confLabel(f.confidence)}</span>
            ) : (
              <span className="conf none">—</span>
            )}
          </div>
        );
      })}
      <div className="actions">
        <span className="muted t-fine" style={{ marginRight: "auto" }}>빈 칸으로 두면 그 문서에 없는 항목으로 처리됩니다.</span>
        <button type="submit" className="btn btn-ghost">확인·저장</button>
      </div>
    </form>
  );
}


function CompareTable({ c }: { c: CaseView }) {
  const mismatchFields = new Set(c.flags.mismatches.map((m) => m.field));
  const rows: (keyof ExtractedFields)[] = ["name", "education_name", "amount", "hours"];
  return (
    <div className="panel">
      <h3 className="t-body-strong">신청 ↔ 제출 대조</h3>
      <table className="compare">
        <thead>
          <tr>
            <th>항목</th>
            <th>신청 내용</th>
            <th>제출 서류</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((k) => {
            const a = c.application?.[k];
            const b = c.completion?.[k];
            if (!a && !b) return null;
            const diff = mismatchFields.has(k as never);
            return (
              <tr key={k} className={diff ? "diff" : ""}>
                <td>{FIELD_LABEL[k]}</td>
                <td>{a ? fmtVal(k, a.value) : "—"}</td>
                <td>{b ? fmtVal(k, b.value) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function FitRationalePanel({ c }: { c: CaseView }) {
  return (
    <div className="panel">
      <div className="rationale-head">
        <h3 className="t-body-strong">직무 부합 근거 <span className="muted t-fine">· AI 상식추론, 세영 님 확인·교정</span></h3>
        {c.fitConfidence && <span className={`conf ${c.fitConfidence}`}>{confLabel(c.fitConfidence)}</span>}
      </div>
      <p className="t-fine muted rationale-meta">
        담당업무 {c.jobRole ?? "미상"}
        {c.remainingPoints != null && <> · 잔여 교육 포인트 <b className="tabnum">{c.remainingPoints}P</b></>}
      </p>

      {c.fitRationale ? (
        <>
          <form action={correctRationale} className="rationale-form">
            <input type="hidden" name="caseId" value={c.id} />
            <textarea name="correction" defaultValue={c.fitRationale} rows={3} className="rationale-edit" />
            <div className="actions">
              <span className="muted t-fine" style={{ marginRight: "auto" }}>고쳐 저장하면 이후 비슷한 건의 근거에 반영됩니다.</span>
              <button type="submit" className="btn btn-ghost">교정 저장</button>
            </div>
          </form>
          <form action={generateRationale} className="rationale-regen">
            <input type="hidden" name="caseId" value={c.id} />
            <RationaleSubmit label="AI로 다시 생성" className="btn-link-muted" />
          </form>
        </>
      ) : (
        <form action={generateRationale} className="actions rationale-empty">
          <input type="hidden" name="caseId" value={c.id} />
          <span className="muted t-caption" style={{ marginRight: "auto" }}>아직 근거가 없습니다.</span>
          <RationaleSubmit label="직무 부합 근거 생성" className="btn btn-ghost" />
        </form>
      )}
    </div>
  );
}

function ActionBar({ c, reasonError }: { c: CaseView; reasonError: boolean }) {
  if (c.status === "DONE") return null;

  if (c.status === "REJECTED") {
    return (
      <div className="actions">
        <form action={reapplyCase}>
          <input type="hidden" name="caseId" value={c.id} />
          <button type="submit" className="btn btn-primary">재신청 만들기</button>
        </form>
      </div>
    );
  }

  if (c.status === "IN_PROGRESS") {
    return (
      <div className="actions">
        <span className="muted t-caption" style={{ marginRight: "auto" }}>이수증이 도착하면 환급 검토로 넘어갑니다.</span>
        <form action={markDocsArrived}>
          <input type="hidden" name="caseId" value={c.id} />
          <button type="submit" className="btn btn-primary">이수증 도착 처리</button>
        </form>
      </div>
    );
  }

  // SCREENING · AWAITING_REFUND — 승인/환급 + 반려(사유 필수)
  const approveLabel = c.status === "SCREENING" ? "승인" : "환급 승인";
  const approveAction = c.status === "SCREENING" ? approveCase : refundCase;
  return (
    <div style={{ marginTop: "var(--sp-lg)" }}>
      <form action={rejectCase} className="reject-form">
        <input type="hidden" name="caseId" value={c.id} />
        <DecisionTimer />
        <textarea
          name="reason"
          placeholder="반려 사유 (필수) — 신청자에게 전달할 근거를 적어주세요."
          aria-invalid={reasonError}
          style={reasonError ? { borderColor: "var(--alert)" } : undefined}
        />
        {reasonError && <span className="t-caption" style={{ color: "var(--alert)" }}>반려하려면 사유를 입력하세요.</span>}
        <div className="actions">
          <button type="submit" className="btn btn-ghost">반려</button>
          <button type="submit" className="btn btn-primary" formAction={approveAction}>{approveLabel}</button>
        </div>
      </form>
    </div>
  );
}

function confLabel(c: "HIGH" | "MID" | "LOW"): string {
  return c === "HIGH" ? "고" : c === "MID" ? "중" : "저";
}
