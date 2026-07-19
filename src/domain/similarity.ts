/**
 * 교육명 유사도 — 이수증↔신청 건 매칭에서 "같은 과정인지" 판단하는 데 쓴다.
 *
 * 완전일치(===)만으로는 발급기관이 붙인 접미사("… 교육과정")나 띄어쓰기·표기 차이를
 * 다른 과정으로 오인한다. 문자 바이그램 Dice 계수 + 포함관계로 느슨하게 본다.
 * 순수 계산이라 규칙을 단위 테스트로 고정한다.
 */

function compact(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

/** 문자 바이그램 집합. 한 글자짜리는 그 글자 자체를 한 원소로. */
function bigrams(s: string): string[] {
  if (s.length < 2) return s ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/** Sørensen–Dice 계수 — 두 바이그램 다중집합의 겹침 비율(0~1). */
function dice(a: string, b: string): number {
  const ga = bigrams(a);
  const gb = bigrams(b);
  if (ga.length === 0 || gb.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const g of ga) counts.set(g, (counts.get(g) ?? 0) + 1);
  let overlap = 0;
  for (const g of gb) {
    const c = counts.get(g) ?? 0;
    if (c > 0) {
      overlap++;
      counts.set(g, c - 1);
    }
  }
  return (2 * overlap) / (ga.length + gb.length);
}

/**
 * 두 교육명이 얼마나 같은 과정인지 0~1. 1=동일, 0=무관.
 * 포함관계(한쪽이 다른 쪽을 통째로 담음)는 접미사 차이로 보고 0.9 이상으로 끌어올린다.
 */
export function educationSimilarity(a: string | null | undefined, b: string | null | undefined): number {
  const ca = compact(a ?? "");
  const cb = compact(b ?? "");
  if (!ca || !cb) return 0;
  if (ca === cb) return 1;
  if (ca.includes(cb) || cb.includes(ca)) return Math.max(0.9, dice(ca, cb));
  return dice(ca, cb);
}

/**
 * 사람 이름 정규화 — 앞뒤 공백·연속 공백·유니코드 표기 차이만 흡수한다.
 * OCR 이 같은 이름을 "권민성 "/"권 민성" 으로 읽어도 같은 사람으로 보게 하되,
 * 글자가 다른 이름은 절대 같게 만들지 않는다(동명이인 판단을 흐리면 안 됨).
 */
export function normalizeName(s: string | null | undefined): string {
  return (s ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
}

/**
 * 부서명 정규화 — 표기용 구분자(공백·가운뎃점·하이픈·슬래시)만 걷어낸다.
 * "총무·인사팀" 과 "총무 인사팀" 은 같게, "인사총무팀" 과 "총무인사팀" 은 다르게 남는다
 * (어순이 다르면 다른 부서일 수 있으므로 사람이 확인하도록 보류로 보낸다).
 */
export function normalizeDept(s: string | null | undefined): string {
  return (s ?? "").normalize("NFC").toLowerCase().replace(/[\s·・\-/,]+/g, "");
}

/** 후보로 볼 최소 유사도 — 이 아래는 "다른 과정"으로 본다. */
export const CANDIDATE_THRESHOLD = 0.5;
/** 다중 후보에서 이 점수 이상이고 2등과 격차가 뚜렷하면 자동 매칭. */
export const AUTO_MATCH_THRESHOLD = 0.7;
/** 자동 매칭에 필요한 1등·2등 점수 격차. */
export const CLEAR_GAP = 0.2;
