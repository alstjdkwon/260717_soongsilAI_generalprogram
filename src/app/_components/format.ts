export function won(v: number | null | undefined): string {
  if (v == null) return "—";
  return `${v.toLocaleString("ko-KR")}원`;
}

/** ‘YYYY-MM-DD HH:MM:SS’ → ‘7월 12일’ */
export function shortDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T"));
  return `${d.getMonth() + 1}월 ${d.getDate()}일`;
}

export function ageLabel(days: number): string {
  if (days <= 0) return "오늘 접수";
  return `접수 ${days}일 전`;
}
