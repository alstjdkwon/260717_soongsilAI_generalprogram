import Link from "next/link";

export function GlobalNav() {
  return (
    <nav className="gnav">
      <div className="wrap">
        <span className="gnav-brand">자율교육 관리</span>
        <div className="gnav-right">
          <span className="demo-badge" title="개인정보 보호를 위해 실제 데이터 대신 가상 데이터로 동작합니다">
            임의 생성 데이터
          </span>
          <span className="gnav-user">전세용 · 총무·인사팀</span>
        </div>
      </div>
    </nav>
  );
}

/** 상단 확장 탭(자율교육 활성 / 나머지 준비중) + 뷰 전환(할일 큐 / 전체 현황). */
export function SubNav({ view }: { view: "queue" | "board" | "report" }) {
  return (
    <div className="subnav">
      <div className="wrap">
        <div className="subnav-tabs">
          <span className="subnav-title">자율교육</span>
          <span className="subnav-soon">인사팀주관교육<span>준비중</span></span>
          <span className="subnav-soon">일반교육<span>준비중</span></span>
        </div>
        <div className="subnav-right">
          <div className="viewswitch">
            <Link href="/" className={view === "queue" ? "active" : ""}>할일 큐</Link>
            <Link href="/board" className={view === "board" ? "active" : ""}>전체 현황</Link>
            <Link href="/report" className={view === "report" ? "active" : ""}>성과</Link>
          </div>
          <a href="/api/export" className="btn btn-ghost btn-sm export-link">
            <ExportIcon />
            엑셀로 내보내기
          </a>
        </div>
      </div>
    </div>
  );
}

function ExportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v12m0 0-4-4m4 4 4-4M5 17v2a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-2"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
