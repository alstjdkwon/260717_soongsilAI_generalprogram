import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb } from "../../../db/serverDb";
import { getCaseView, type CaseView } from "../../../repo/queries";
import type { ExtractedFields } from "../../../domain/flags";
import { won, shortDate } from "../../_components/format";
import { GlobalNav } from "../../_components/Nav";
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

export default async function CaseDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ err?: string }>;
}) {
  const { id } = await params;
  const { err } = await searchParams;
  const db = getDb();
  const c = getCaseView(db, Number(id));
  if (!c) notFound();

  const prev = c.prevCaseId
    ? (db.prepare("SELECT education_name, reject_reason FROM cases WHERE id = ?").get(c.prevCaseId) as
        | { education_name: string | null; reject_reason: string | null }
        | undefined)
    : undefined;

  const showCompare = c.status === "AWAITING_REFUND" && c.completion;
  const editable = c.status === "SCREENING" || c.status === "IN_PROGRESS";
  const leftFields = showCompare ? c.completion! : c.application;
  const leftKind = showCompare ? "이수증 / 결과보고서" : "자율교육 신청서";

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
          {/* 좌: 원본 문서 팩시밀리 */}
          <div className="paper">
            <div className="paper-bar">
              <span className="t-caption-strong">{leftKind}</span>
              <span className="t-fine muted">임의 생성 문서</span>
            </div>
            <div className="paper-body">
              <p className="paper-title">{leftKind}</p>
              <p className="paper-sub">숭실대학교 · 교직원 자율교육</p>
              <dl style={{ margin: 0 }}>
                {FIELD_ORDER.map((k) => {
                  const f = leftFields?.[k];
                  if (!f) return null;
                  return (
                    <div className="paper-row" key={k}>
                      <dt>{FIELD_LABEL[k]}</dt>
                      <dd>{fmtVal(k, f.value)}</dd>
                    </div>
                  );
                })}
              </dl>
              <p className="paper-stamp">스캔본 · {shortDate(c.docsArrivedAt ?? c.createdAt)}</p>
            </div>
          </div>

          {/* 우: AI 추출 / 대조 / 근거 */}
          <div>
            {showCompare ? (
              <CompareTable c={c} />
            ) : editable && c.application && c.applicationDocId ? (
              <FieldsForm caseId={c.id} documentId={c.applicationDocId} fields={c.application} />
            ) : (
              <ReadOnlyFields fields={leftFields} />
            )}

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

function FieldsForm({
  caseId,
  documentId,
  fields,
}: {
  caseId: number;
  documentId: number;
  fields: ExtractedFields;
}) {
  return (
    <form action={saveFields} className="panel">
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="documentId" value={documentId} />
      <h3 className="t-body-strong">AI 추출 필드 <span className="muted t-fine">· 저신뢰 필드는 원본과 대조해 고치세요</span></h3>
      {FIELD_ORDER.map((k) => {
        const f = fields[k];
        if (!f) return null;
        const low = f.confidence === "LOW";
        return (
          <div className={`field${low ? " low" : ""}`} key={k}>
            <label htmlFor={`f_${k}`}>{FIELD_LABEL[k]}</label>
            <input
              id={`f_${k}`}
              name={`f_${k}`}
              defaultValue={f.value == null ? "" : String(f.value)}
            />
            <span className={`conf ${f.confidence}`}>{confLabel(f.confidence)}</span>
          </div>
        );
      })}
      <div className="actions">
        <button type="submit" className="btn btn-ghost">확인·저장</button>
      </div>
    </form>
  );
}

function ReadOnlyFields({ fields }: { fields?: ExtractedFields }) {
  if (!fields) return null;
  return (
    <div className="panel">
      <h3 className="t-body-strong">추출 필드</h3>
      {FIELD_ORDER.map((k) => {
        const f = fields[k];
        if (!f) return null;
        return (
          <div className="field" key={k}>
            <label>{FIELD_LABEL[k]}</label>
            <span className="val">{fmtVal(k, f.value)}</span>
            <span className={`conf ${f.confidence}`}>{confLabel(f.confidence)}</span>
          </div>
        );
      })}
    </div>
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
            <button type="submit" className="btn-link-muted">AI로 다시 생성</button>
          </form>
        </>
      ) : (
        <form action={generateRationale} className="actions rationale-empty">
          <input type="hidden" name="caseId" value={c.id} />
          <span className="muted t-caption" style={{ marginRight: "auto" }}>아직 근거가 없습니다.</span>
          <button type="submit" className="btn btn-ghost">직무 부합 근거 생성</button>
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
