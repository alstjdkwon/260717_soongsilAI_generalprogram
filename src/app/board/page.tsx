import Link from "next/link";
import { getDb } from "../../db/serverDb";
import { BOARD_COLUMNS, getBoard, type CaseView } from "../../repo/queries";
import { CASE_STATUS } from "../../domain/status";
import { GlobalNav, SubNav } from "../_components/Nav";

export const dynamic = "force-dynamic";

export default function BoardPage() {
  const board = getBoard(getDb());

  return (
    <>
      <GlobalNav />
      <SubNav view="board" />
      <main className="wrap board">
        <div className="board-scroll">
          {BOARD_COLUMNS.map((status) => {
            const cases = board[status];
            return (
              <div key={status}>
                <div className="bcol-head">
                  <span className={`sdot ${status}`} aria-hidden />
                  <h2>{CASE_STATUS[status]}</h2>
                  <span className="count tabnum">{cases.length}</span>
                </div>
                <div className="stack">
                  {cases.length === 0 ? (
                    <div className="empty">없음</div>
                  ) : (
                    cases.map((c) => <BoardCard key={c.id} c={c} />)
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </main>
    </>
  );
}

function BoardCard({ c }: { c: CaseView }) {
  return (
    <Link href={`/case/${c.id}`} className={`bcard${c.flags.needsReview ? " flagged" : ""}`}>
      <b>{c.name}</b>
      <div className="bmeta">{c.department} · {c.educationName}</div>
    </Link>
  );
}
