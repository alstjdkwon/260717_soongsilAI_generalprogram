import { attachPendingDocument, dismissPendingDocument } from "../actions";
import type { PendingDocView, PendingCandidate } from "../../repo/queries";
import { won } from "./format";

/**
 * 후보 확인 필요 — 자동 매칭이 위험한 이수증(동명이인·다중 이수대기)을 세영 님이 직접 붙인다.
 * 이수증에서 뽑은 정보 옆에 후보 건들을 나열하고, 고른 건에 첨부한다.
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
    <section className="pending" aria-label="후보 확인 필요">
      <div className="pending-head">
        <h2 className="t-display-md">후보 확인 필요</h2>
        <span className="count tabnum">{pending.length}</span>
      </div>
      <p className="col-desc">
        자동으로 붙이기 어려운 이수증입니다. 어느 건에 붙일지 골라 주세요.
      </p>

      <div className="pending-stack">
        {pending.map((p) => (
          <div className="pending-card" key={p.id}>
            <div className="pending-doc">
              <span className="t-caption-strong">제출된 이수증</span>
              <p className="pending-name">{p.name ?? "이름 미상"}</p>
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
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
