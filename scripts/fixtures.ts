/**
 * 가상 양식 PDF 정답셋 (기획서 §8: 명백한 가상값 + "임의 생성 데이터").
 *
 * 생성기(make-pdfs.ts)와 라이브 검증(verify-ingest.ts)이 함께 쓴다.
 * - 생성기: 이 명세대로 PDF를 그린다.
 * - 검증기: `kind`/`expect`를 정답으로 삼아 판별 정확도·저신뢰 플래그를 채점한다.
 *
 * 실제 신청서 양식이 도착하면 이 파일과 생성기는 폐기하고, 파서를 규칙기반으로 교체한다(A4).
 */

export type FixtureKind = "APPLICATION" | "COMPLETION";
/** 이수증은 일부러 서로 다른 폼으로 — OCR·추출이 폼 편차에 견디는지 확인(기획서 §7). */
export type FormStyle = "APPLICATION" | "CERT_A" | "CERT_B" | "CERT_C";

export interface Fixture {
  file: string;
  kind: FixtureKind;
  form: FormStyle;
  expect: {
    name: string;
    department?: string;
    education_name: string;
    amount: number;
    hours?: number;
  };
  /** 스캔 열화 시뮬레이션(가림·회전 스탬프·노이즈) — 추출이 저신뢰로 플래그돼야 하는 건. */
  degrade?: boolean;
  /** 검증 메모 — 이 건이 무엇을 테스트하는지. */
  note?: string;
}

export const FIXTURES: Fixture[] = [
  // ── 신청서(고정폼) ────────────────────────────────────
  {
    file: "app-01-kim.pdf",
    kind: "APPLICATION",
    form: "APPLICATION",
    expect: { name: "김도윤", department: "전산팀", education_name: "쿠버네티스 운영 실무", amount: 95000 },
    note: "깨끗한 신청서 — 판별·추출 모두 고신뢰 기대",
  },
  {
    file: "app-02-seo.pdf",
    kind: "APPLICATION",
    form: "APPLICATION",
    expect: { name: "서지우", department: "홍보팀", education_name: "영상 편집 기초", amount: 60000 },
    note: "깨끗한 신청서",
  },
  {
    file: "app-03-han.pdf",
    kind: "APPLICATION",
    form: "APPLICATION",
    expect: { name: "한예린", department: "회계팀", education_name: "재무제표 분석 실무", amount: 80000 },
    note: "깨끗한 신청서 — 뒤의 열화 이수증(comp-03)과 매칭될 신청 원본",
  },
  {
    file: "app-04-jung.pdf",
    kind: "APPLICATION",
    form: "APPLICATION",
    expect: { name: "정우성", department: "기획팀", education_name: "파이썬 데이터 분석", amount: 75000 },
    note: "깨끗한 신청서 — 금액 불일치 이수증(comp-04)과 매칭될 신청 원본",
  },

  // ── 이수증(폼 제각각) ─────────────────────────────────
  {
    file: "comp-01-kim.pdf",
    kind: "COMPLETION",
    form: "CERT_A",
    expect: { name: "김도윤", education_name: "쿠버네티스 운영 실무", amount: 95000, hours: 24 },
    note: "폼 A(표 형식) · app-01 매칭 · 정상",
  },
  {
    file: "comp-02-seo.pdf",
    kind: "COMPLETION",
    form: "CERT_B",
    expect: { name: "서지우", education_name: "영상 편집 기초", amount: 60000, hours: 16 },
    note: "폼 B(증서 형식) · app-02 매칭 · 정상",
  },
  {
    file: "comp-03-han.pdf",
    kind: "COMPLETION",
    form: "CERT_C",
    expect: { name: "한예린", education_name: "재무제표 분석 실무", amount: 80000, hours: 20 },
    degrade: true,
    note: "폼 C(열화 스캔) · app-03 매칭 · 금액·시간이 가려져 저신뢰 플래그 기대",
  },
  {
    file: "comp-04-jung-mismatch.pdf",
    kind: "COMPLETION",
    form: "CERT_B",
    expect: { name: "정우성", education_name: "파이썬 데이터 분석", amount: 90000, hours: 20 },
    note: "폼 B · app-04 매칭이나 금액 불일치(75,000↔90,000) — Phase 4 대조 검증용",
  },
];
