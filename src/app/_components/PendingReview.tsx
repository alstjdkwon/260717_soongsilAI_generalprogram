import Link from "next/link";
import {
  attachPendingDocument,
  dismissPendingDocument,
  resolvePendingAsExisting,
  resolvePendingAsNew,
} from "../actions";
import type { PendingDocView, PendingCandidate } from "../../repo/queries";
import { CASE_STATUS } from "../../domain/status";
import { won } from "./format";

/**
 * 확인 필요 — 자동 처리가 위험한 문서를 세영 님이 직접 결정한다.
 *  - 이수증: 어느 건에 붙일지 (동명이인·다중 이수대기·이름 오인식)
 *  - 신청서: 동명이인인지 표기 차이인지 / 중복 제출인지
 */
export function PendingReview({
  pending,
  attachable,
}: {
  pending: PendingDocView[];
  attachable: PendingCandidate[];
}) {
  if (pending.length === 0) return null;

  return (
    <section className="pending" aria-label="확인 필요">
      <div className="pending-head">
        <h2 className="t-display-md">확인 필요</h2>
        <span className="count tabnum">{pending.length}</span>
      </div>
      <p className="col-desc">
        기계가 자동으로 처리하면 위험한 서류입니다. 어떻게 할지 골라 주세요.
      </p>

      <div className="pending-stack">
        {pending.map((p) => (
          <div className="pending-card" key={p.id}>
            <div className="pending-doc">
              <span className="t-caption-strong">
                {p.holdReason === null ? "제출된 이수증" : "제출된 신청서"}
              </span>
              <p className="pending-name">{p.name ?? "이름 미상"}</p>
              {p.department && <p className="t-caption muted">{p.department}</p>}
              <p className="t-caption muted">{p.educationName ?? "교육명 미상"}</p>
              <p className="t-fine muted">
                {p.amount != null ? won(p.amount) : "금액 —"}
                {p.hours != null ? ` · ${p.hours}시간` : ""}
              </p>
              <form action={dismissPendingDocument} className="pending-dismiss">
                <input type="hidden" name="pendingId" value={p.id} />
                <button type="submit" className="btn-link-muted">버리기</button>
              </form>
            </div>

            <div className="pending-cands">
              {p.holdReason === "DEPT_MISMATCH" ? (
                <DeptMismatch p={p} />
              ) : p.holdReason === "DUPLICATE" ? (
                <Duplicate p={p} />
              ) : (
                <CompletionPick p={p} attachable={attachable} />
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/** 이름은 같은데 부서가 다르다 — 같은 사람인지 동명이인인지는 사람만 안다. */
function DeptMismatch({ p }: { p: PendingDocView }) {
  return (
    <>
      <span className="t-caption muted">
        이름이 같은 직원이 있지만 부서가 다릅니다 — 같은 사람인가요?
      </span>
      <div className="pending-cand-row">
        {p.sameNameEmployees.map((e) => (
          <form action={resolvePendingAsExisting} key={e.employeeId}>
            <input type="hidden" name="pendingId" value={p.id} />
            <input type="hidden" name="employeeId" value={e.employeeId} />
            <button type="submit" className="cand-btn">
              <span className="cand-edu">같은 사람 — {e.department ?? "부서 미상"}</span>
              <span className="cand-cost t-fine muted">기존 {e.caseCount}건에 추가</span>
            </button>
          </form>
        ))}
        <form action={resolvePendingAsNew}>
          <input type="hidden" name="pendingId" value={p.id} />
          <button type="submit" className="cand-btn">
            <span className="cand-edu">동명이인 — 새 직원으로</span>
            <span className="cand-cost t-fine muted">{p.department ?? "부서 미상"}</span>
          </button>
        </form>
      </div>
    </>
  );
}

/** 같은 사람이 같은 교육을 이미 신청해 뒀다 — 실수로 두 번 올렸는지 진짜 재신청인지. */
function Duplicate({ p }: { p: PendingDocView }) {
  if (!p.conflict) {
    return <span className="t-caption muted">충돌한 건을 찾을 수 없습니다. 버리거나 새 건으로 만드세요.</span>;
  }
  return (
    <>
      <span className="t-caption muted">
        같은 교육의 진행중 신청이 이미 있습니다 — 중복 업로드인가요?
      </span>
      <p className="t-fine muted">
        기존 건:{" "}
        <Link href={`/case/${p.conflict.caseId}`} className="dz-link">
          {p.conflict.educationName ?? "교육명 미상"} · {CASE_STATUS[p.conflict.status]}
        </Link>
      </p>
      <div className="pending-cand-row">
        <form action={resolvePendingAsExisting}>
          <input type="hidden" name="pendingId" value={p.id} />
          <input type="hidden" name="employeeId" value={p.conflict.employeeId} />
          <button type="submit" className="cand-btn">
            <span className="cand-edu">중복 아님 — 새 건으로</span>
            <span className="cand-cost t-fine muted">같은 직원에 추가</span>
          </button>
        </form>
      </div>
    </>
  );
}

/** 이수증을 어느 심사 건에 붙일지 고른다(기존 Phase 4 흐름). */
function CompletionPick({ p, attachable }: { p: PendingDocView; attachable: PendingCandidate[] }) {
  return (
    <>
      {p.candidates.length > 0 ? (
        <>
          <span className="t-caption muted">이 사람의 이수 대기 건 — 붙일 건 선택</span>
          <div className="pending-cand-row">
            {p.candidates.map((c) => (
              <form action={attachPendingDocument} key={c.caseId}>
                <input type="hidden" name="pendingId" value={p.id} />
                <input type="hidden" name="caseId" value={c.caseId} />
                <button type="submit" className="cand-btn">
                  <span className="cand-edu">{c.educationName ?? "교육명 미상"}</span>
                  <span className="cand-cost t-fine muted">신청 {won(c.expectedCost)}</span>
                </button>
              </form>
            ))}
          </div>
        </>
      ) : (
        <span className="t-caption muted">
          이름이 맞는 이수 대기 건을 찾지 못했습니다(OCR 오류·오탈자일 수 있음).
        </span>
      )}

      {/* 이름 매칭이 실패했거나 후보가 다 아닐 때 — 이수 대기 건 전체에서 직접 고른다. */}
      {attachable.length > 0 ? (
        <form action={attachPendingDocument} className="pending-manual">
          <input type="hidden" name="pendingId" value={p.id} />
          <label htmlFor={`pick-${p.id}`} className="t-fine muted">직접 고르기</label>
          <select id={`pick-${p.id}`} name="caseId" className="pending-select" defaultValue="">
            <option value="" disabled>이수 대기 건 선택…</option>
            {attachable.map((c) => (
              <option key={c.caseId} value={c.caseId}>
                {c.name} — {c.educationName ?? "교육명 미상"} ({won(c.expectedCost)})
              </option>
            ))}
          </select>
          <button type="submit" className="btn btn-ghost btn-sm">붙이기</button>
        </form>
      ) : (
        <span className="t-fine muted">
          붙일 수 있는 이수 대기 건이 없습니다. 신청서를 먼저 올려 승인하세요.
        </span>
      )}
    </>
  );
}
