import type { ReactNode } from "react";
import { getDb } from "../db/serverDb";
import { getQueue, getPendingDocuments, getAttachableCases } from "../repo/queries";
import { getOverdueWeeks } from "../repo/settings";
import { setOverdueSetting } from "./actions";
import { GlobalNav, SubNav } from "./_components/Nav";
import { CaseCard } from "./_components/CaseCard";
import { Dropzone } from "./_components/Dropzone";
import { PendingReview } from "./_components/PendingReview";

export const dynamic = "force-dynamic";

export default function QueuePage() {
  const db = getDb();
  const q = getQueue(db);
  const pending = getPendingDocuments(db);
  const attachable = getAttachableCases(db);
  const overdueWeeks = getOverdueWeeks(db);
  const actionable = q.review.length + q.processing.length;

  return (
    <>
      <GlobalNav />
      <SubNav view="queue" />
      <main className="wrap">
        <section className="drop" aria-label="문서 업로드">
          <Dropzone />
          <div className="drop-side">
            <div className="drop-stat">
              <b className="tabnum">{actionable}</b>
              <span className="t-caption">오늘 처리할 건</span>
            </div>
            <div className="drop-stat">
              <b className="tabnum" style={{ color: q.review.length ? "#ff6b6b" : undefined }}>{q.review.length}</b>
              <span className="t-caption">검토 필요</span>
            </div>
          </div>
        </section>

        <PendingReview pending={pending} attachable={attachable} />

        <section className="queue" aria-label="할일 큐">
          <QueueColumn
            className="col-review"
            title="검토 필요"
            desc="AI 신뢰도가 낮거나 서류가 신청과 어긋난 건. 먼저 보세요."
            cases={q.review}
            emptyText="어긋나거나 불확실한 건이 없습니다."
          />
          <QueueColumn
            title="처리 대기"
            desc="세영 님이 승인·환급을 결정할 차례인 건."
            cases={q.processing}
            emptyText="지금 결정할 건이 없습니다."
          />
          <QueueColumn
            title="경과 알림"
            desc={`이수 대기가 ${overdueWeeks}주를 넘긴 건. 진행 상황을 확인하세요.`}
            cases={q.overdue}
            emptyText="기한을 넘긴 건이 없습니다."
            control={
              <form action={setOverdueSetting} className="overdue-setting">
                <span>알림 기준</span>
                <input type="number" name="weeks" defaultValue={overdueWeeks} min={1} max={52} className="overdue-input" aria-label="경과 알림 기준(주)" />
                <span>주</span>
                <button type="submit" className="btn-link-muted">적용</button>
              </form>
            }
          />
        </section>
      </main>
    </>
  );
}

function QueueColumn({
  title,
  desc,
  cases,
  emptyText,
  className,
  control,
}: {
  title: string;
  desc: string;
  cases: ReturnType<typeof getQueue>["review"];
  emptyText: string;
  className?: string;
  control?: ReactNode;
}) {
  return (
    <div className={className}>
      <div className="col-head">
        <h2 className="t-display-md">{title}</h2>
        <span className="count tabnum">{cases.length}</span>
      </div>
      <p className="col-desc">{desc}</p>
      {control}
      {cases.length === 0 ? (
        <div className="empty">{emptyText}</div>
      ) : (
        <div className="stack">
          {cases.map((c) => (
            <CaseCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </div>
  );
}
