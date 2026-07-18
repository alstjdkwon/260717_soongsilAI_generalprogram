import Link from "next/link";
import type { CaseView } from "../../repo/queries";
import { ageLabel } from "./format";

export function CaseCard({ c }: { c: CaseView }) {
  const flagged = c.flags.needsReview;
  const overdueHot = c.bucket === "OVERDUE" || c.flags.isOverdue;
  return (
    <Link href={`/case/${c.id}`} className={`card${flagged ? " flagged" : ""}`}>
      <div className="card-top">
        <div className="who">
          <span className={`sdot ${c.status}`} aria-hidden />
          <b>{c.name}</b>
          <span className="dept">{c.department}</span>
        </div>
        <span className={`age${overdueHot ? " hot" : ""}`}>
          {overdueHot ? `${c.flags.overdueWeeks}주 경과` : ageLabel(c.ageDays)}
        </span>
      </div>

      <div className="edu">{c.educationName}</div>

      <div className="card-meta">
        <span>{c.statusLabel}</span>
        {c.remainingPoints != null && (
          <>
            <span className="dot" aria-hidden />
            <span className="tabnum">잔여 {c.remainingPoints}P</span>
          </>
        )}
      </div>

      {c.reason && (
        <div className={`reason${flagged ? "" : " warn"}`}>
          <span>{c.reason}</span>
        </div>
      )}
    </Link>
  );
}
