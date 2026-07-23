import Link from "next/link";
import { getDb } from "../../db/serverDb";
import { getMetrics, type Scope } from "../../repo/metrics";
import { GlobalNav, SubNav } from "../_components/Nav";

export const dynamic = "force-dynamic";

/** 표본이 이보다 적으면 중앙값이 크게 흔들린다 — 화면이 스스로 경고하게 한다. */
const SMALL_SAMPLE = 10;

function secondsLabel(s: number | null): string {
  if (s == null) return "—";
  if (s < 60) return `${s}초`;
  return `${Math.floor(s / 60)}분 ${s % 60}초`;
}

function daysLabel(d: number | null): string {
  return d == null ? "—" : `${Math.round(d * 10) / 10}일`;
}

export default async function ReportPage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string }>;
}) {
  const { scope: raw } = await searchParams;
  const scope: Scope = raw === "all" ? "all" : "real";
  const m = getMetrics(getDb(), scope);

  return (
    <>
      <GlobalNav />
      <SubNav view="report" />
      <main className="wrap report">
        <div className="report-head">
          <div>
            <h1 className="t-display-md" style={{ margin: 0 }}>성과 측정</h1>
            <p className="t-caption muted" style={{ margin: "6px 0 0" }}>
              모든 수치에 표본 수(N)와 정의를 함께 적었습니다. 숫자를 검증하려면 원시데이터를 받아
              직접 계산해 대조하세요.
            </p>
          </div>
          <a href={`/api/report/export?scope=${scope}`} className="btn btn-ghost btn-sm">
            원시데이터 내려받기
          </a>
        </div>

        <div className="report-scope">
          <div className="viewswitch">
            <Link href="/report" className={scope === "real" ? "active" : ""}>실사용만</Link>
            <Link href="/report?scope=all" className={scope === "all" ? "active" : ""}>시드 포함</Link>
          </div>
          <span className="t-fine muted">
            전체 {m.totalCases}건
            {scope === "all" && " · 시드(데모) 건이 섞여 있어 보고서에는 쓸 수 없습니다"}
          </span>
        </div>

        {m.totalCases === 0 && (
          <div className="banner warn">
            <b>아직 데이터가 없습니다</b>
            <span>
              실사용이 시작되어야 수치가 쌓입니다. 집계 로직이 도는지 확인하려면 「시드 포함」으로 보세요.
            </span>
          </div>
        )}

        <Metric
          title="판단 소요시간"
          value={secondsLabel(m.decisionSeconds.median)}
          n={m.decisionSeconds.n}
          definition="상세 화면을 연 뒤 승인·반려를 누르기까지 걸린 시간의 중앙값."
          sheet="건별"
          extra={
            m.decisionSeconds.n > 0
              ? `최소 ${secondsLabel(m.decisionSeconds.min)} · 최대 ${secondsLabel(m.decisionSeconds.max)}`
              : undefined
          }
          caveat="탭을 열어둔 채 자리를 비우면 부풀려집니다. 그래서 평균이 아니라 중앙값을 씁니다."
        />

        <Metric
          title="신청 → 결정 리드타임"
          value={daysLabel(m.leadTimeDays.median)}
          n={m.leadTimeDays.n}
          definition="접수부터 승인·반려까지의 달력 일수 중앙값."
          sheet="건별"
          extra={
            m.leadTimeDays.n > 0
              ? `최소 ${daysLabel(m.leadTimeDays.min)} · 최대 ${daysLabel(m.leadTimeDays.max)}`
              : undefined
          }
          caveat="주말·휴가가 포함된 달력 시간입니다. 위의 판단 소요시간과는 다른 수치입니다."
        />

        <Metric
          title="AI 근거 무수정 채택률"
          value={m.adoption.rate == null ? "—" : `${Math.round(m.adoption.rate * 100)}%`}
          n={m.adoption.n}
          definition="교정 저장을 누른 건 중, AI 원문이 그대로 유지된 비율."
          sheet="근거비교"
          extra={m.adoption.n > 0 ? `${m.adoption.n}건 중 ${m.adoption.adopted}건 채택` : undefined}
          caveat="근거를 읽고 동의해서 교정 저장을 누르지 않고 승인한 건은 분모에 들어가지 않습니다."
        />

        <Metric
          title="이수 대기 방치"
          value={`${m.overdue.overdue}건`}
          n={m.overdue.n}
          definition={`이수 대기 중 승인 후 ${m.overdue.limitWeeks}주를 넘긴 건수.`}
          sheet="건별"
          caveat="개선 전 방치 건수는 도구가 알 수 없습니다. 비교하려면 기존 관리 엑셀의 수치가 필요합니다."
        />

        <div className="panel report-pending">
          <h3 className="t-body-strong">OCR 필드 정확도 <span className="muted t-fine">· 아직 측정 불가</span></h3>
          <p className="t-caption muted" style={{ margin: 0 }}>
            사람이 문서를 실제로 확인했는지 기록하는 값(<code>fields_reviewed_at</code>)이 아직 없습니다.
            지금 계산하면 <b>열어보지도 않은 문서가 「100% 정확」으로 잡힙니다</b> — 원본과 최종값이
            당연히 같기 때문입니다. 원시 대조표는 엑셀 「필드비교」 시트에 이미 들어 있습니다.
          </p>
        </div>
      </main>
    </>
  );
}

function Metric({
  title,
  value,
  n,
  definition,
  sheet,
  extra,
  caveat,
}: {
  title: string;
  value: string;
  n: number;
  definition: string;
  sheet: string;
  extra?: string;
  caveat: string;
}) {
  return (
    <div className="panel report-metric">
      <div className="report-metric-head">
        <h3 className="t-body-strong" style={{ margin: 0 }}>{title}</h3>
        <span className="chip tabnum">N = {n}</span>
      </div>
      <p className="report-value tabnum">{value}</p>
      {extra && <p className="t-caption muted report-extra tabnum">{extra}</p>}
      <p className="t-caption report-def">{definition}</p>
      {n > 0 && n < SMALL_SAMPLE && (
        <p className="t-fine report-warn">표본 {n}건 — 한두 건에 크게 흔들립니다. 단정적으로 쓰지 마세요.</p>
      )}
      <p className="t-fine muted">검증: 엑셀 「{sheet}」 시트 · {caveat}</p>
    </div>
  );
}
