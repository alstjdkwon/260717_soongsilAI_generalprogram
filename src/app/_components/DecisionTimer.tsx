"use client";

import { useEffect, useRef } from "react";

/**
 * 상세 화면을 연 뒤 승인/반려를 누르기까지의 경과시간(ms)을 폼에 실어 보낸다.
 * 서버 시계와 브라우저 시계를 섞지 않도록 경과시간을 클라이언트에서 계산한다.
 *
 * 초기값을 빈 문자열로 두는 이유: 서버 렌더와 클라이언트 렌더가 같아야 hydration 경고가 안 난다.
 * 실제 값은 마운트 후 effect 에서 채운다.
 *
 * 한계: 탭을 열어둔 채 자리를 비우면 값이 부풀려진다. 집계할 때 평균이 아니라 중앙값으로 읽을 것.
 */
export function DecisionTimer() {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const input = ref.current;
    const form = input?.form;
    if (!input || !form) return;

    const openedAt = Date.now();
    const onSubmit = () => {
      input.value = String(Date.now() - openedAt);
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, []);

  return <input ref={ref} type="hidden" name="elapsedMs" defaultValue="" />;
}
