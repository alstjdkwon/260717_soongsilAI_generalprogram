import { describe, it, expect } from "vitest";
import { educationSimilarity } from "./similarity";

describe("educationSimilarity", () => {
  it("완전히 같으면 1", () => {
    expect(educationSimilarity("재무제표 분석 실무", "재무제표 분석 실무")).toBe(1);
  });

  it("띄어쓰기·대소문자만 다르면 1로 본다", () => {
    expect(educationSimilarity("재무제표 분석 실무", "재무제표분석실무")).toBe(1);
  });

  it("발급기관이 접미사를 붙여도(포함관계) 높게 본다", () => {
    // OCR 실측 사례: 신청서 '재무제표 분석 실무' ↔ 이수증 '재무제표 분석 실무 교육과정'
    expect(educationSimilarity("재무제표 분석 실무", "재무제표 분석 실무 교육과정")).toBeGreaterThanOrEqual(0.9);
  });

  it("전혀 다른 과정은 낮게 본다", () => {
    expect(educationSimilarity("재무제표 분석 실무", "쿠버네티스 운영 실무")).toBeLessThan(0.5);
  });

  it("빈 값은 0", () => {
    expect(educationSimilarity("", "무엇")).toBe(0);
    expect(educationSimilarity("무엇", null)).toBe(0);
  });

  it("부분적으로 겹치는 유사 과정은 중간값", () => {
    const s = educationSimilarity("파이썬 데이터 분석", "파이썬 데이터 분석 기초");
    expect(s).toBeGreaterThanOrEqual(0.9); // 포함관계
    // 접두 '엑셀'·접미 '함수'만 겹치고 고급↔기초로 갈리는 애매 케이스 → 중간 이하
    const s2 = educationSimilarity("엑셀 고급 함수", "엑셀 기초 함수");
    expect(s2).toBeGreaterThan(0.3);
    expect(s2).toBeLessThan(0.6);
  });
});
