// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 대응현황 CSV → 구조화 데이터 변환 (버그 수정판 v6.1)
//
// 수정 내역:
// [버그1] openid 체크를 날짜 상속보다 먼저 해서 lastDate 미전파 → 연쇄 스킵 발생
//         → openid 없는 행도 날짜가 있으면 lastDate 업데이트 후 스킵
// [버그2] 날짜 없는 행은 무조건 스킵 → lastDate가 있으면 사용하도록 변경
//         → "날짜가 여전히 없으면 스킵" 조건을 date 컬럼 탐지 실패 시에만 적용
// [버그3] iOS 헤더의 date 컬럼명이 다를 경우 탐지 실패
//         → 날짜 패턴 직접 스캔으로 date 컬럼 자동 추론 추가
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseResponseCSV(text, country, platform, colMap) {
  const allRows = parseCSVRobust(text);
  if (allRows.length < 2) return [];
  const headers = allRows[0];

  const findCol = (names) => {
    for (const name of names) {
      const idx = headers.findIndex(h => h && h.trim().toLowerCase().includes(name.toLowerCase()));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const autoOrAI = (names, aiKey) => {
    const auto = findCol(names);
    if (auto >= 0) return auto;
    if (colMap?.[aiKey] != null) {
      const aiIdx = headers.indexOf(colMap[aiKey]);
      if (aiIdx >= 0) return aiIdx;
    }
    return -1;
  };

  let ci = {
    date:           autoOrAI(["Date", "date", "날짜", "등록일", "문의일", "접수일"], "date"),
    openid:         autoOrAI(["openid", "OPENID", "OpenID", "오픈ID", "오픈id"], "openid"),
    cancelOrderNo:  autoOrAI(["결제취소 주문번호", "결제취소 주문"], "cancelOrderNo"),
    cancelProduct:  autoOrAI(["결제취소 상품명", "결제취소 상품"], "cancelProduct"),
    requestDate:    autoOrAI(["해제 요청 일시", "해제 요청"], "requestDate"),
    ticketNo:       autoOrAI(["Ticket NO", "Ticket", "티켓"], "ticketNo"),
    releaseDate:    autoOrAI(["해제 일시", "해제일시"], "releaseDate"),
    rechargeOrderNo: autoOrAI(["재결제 주문번호", "재결제 주문"], "rechargeOrderNo"),
    rechargeProduct: autoOrAI(["재결제 상품명", "재결제 상품"], "rechargeProduct"),
    rechargeAmount:  autoOrAI(["재결제 금액"], "rechargeAmount"),
    processDate:    autoOrAI(["처리날짜", "처리일", "처리 날짜"], "processDate"),
    processResult:  autoOrAI(["처리결과", "처리 결과"], "processResult"),
  };

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // [버그3 수정] date 컬럼을 못 찾은 경우,
  // 실제 데이터 행을 스캔해서 날짜 패턴이 있는 컬럼을 자동 추론
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  if (ci.date < 0) {
    const dateLikePattern = /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}|[A-Za-z]+\s+\d+,\s*\d{4}/;
    // 상위 10개 데이터 행에서 날짜처럼 보이는 컬럼 찾기
    let colScores = {};
    for (let i = 1; i < Math.min(11, allRows.length); i++) {
      allRows[i].forEach((cell, idx) => {
        if (dateLikePattern.test(String(cell || ""))) {
          colScores[idx] = (colScores[idx] || 0) + 1;
        }
      });
    }
    const best = Object.entries(colScores).sort((a, b) => b[1] - a[1])[0];
    if (best) {
      ci.date = parseInt(best[0]);
      console.log(`🔍 [${platform}] date 컬럼 자동 추론: index=${ci.date} (헤더: "${headers[ci.date]}")`);
    }
  }

  console.log("📊 컬럼 매핑:", headers.map((h,i)=>`${i}:${h}`).join(" | "));
  console.log("📊 매핑 결과:", JSON.stringify(ci));

  const get = (row, idx) => (idx >= 0 && idx < row.length) ? row[idx] : "";

  const results = [];
  let lastDate = null;

  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || row.length < 3) continue;
    if (row.every(c => !c || c.trim() === "")) continue;

    const dateRaw = get(row, ci.date);
    const openid = get(row, ci.openid);
    const processDateRaw = get(row, ci.processDate).trim();
    const resultText = get(row, ci.processResult).trim();

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // [버그1 수정] 날짜 파싱 및 lastDate 업데이트를
    // openid 체크보다 먼저 수행
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let dateParsed = parseDate(dateRaw);
    if (dateParsed) {
      lastDate = dateParsed; // openid 유무와 관계없이 날짜 항상 갱신
    } else {
      dateParsed = lastDate; // 날짜 없으면 이전 행 날짜 상속
    }

    // openid가 없으면 (날짜 업데이트 후) 스킵
    if (!openid || openid.trim() === "") continue;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // [버그2 수정] 날짜가 없는 경우 처리
    // date 컬럼 자체를 못 찾은 경우만 스킵,
    // 컬럼은 있지만 값이 비어서 상속 중인 경우는 통과
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    if (!dateParsed) {
      // date 컬럼도 없고 processDate에서도 날짜 추출 시도
      const fallbackDate = parseDate(processDateRaw);
      if (fallbackDate) {
        dateParsed = fallbackDate;
        lastDate = fallbackDate;
      } else {
        console.warn(`⚠️ [${platform}] row ${i}: 날짜 없음 스킵 (openid: ${openid})`);
        continue;
      }
    }

    const [year, month, day] = dateParsed.split("-").map(Number);

    const combinedText = (processDateRaw + " " + resultText).trim();
    const processDateParsed = parseDate(processDateRaw);

    let status = "처리중";
    let resanctioned = false;
    let displayResult = resultText || "";

    if (!resultText && processDateRaw) {
      const withoutDate = processDateRaw.replace(/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/g, "").trim();
      if (withoutDate) displayResult = withoutDate;
    }

    if (combinedText === "") {
      status = "처리중";
    } else if (
      combinedText.includes("제재") || combinedText.includes("제제") ||
      combinedText.includes("정지") || combinedText.includes("밴") ||
      combinedText.includes("하지 않아") || combinedText.includes("하지않아") ||
      combinedText.includes("않음") || combinedText.includes("안하") ||
      combinedText.includes("안 하") || combinedText.includes("부족") ||
      combinedText.includes("재재정") || combinedText.includes("사용했습니다")
    ) {
      status = "재제재";
      resanctioned = true;
    } else if (combinedText.includes("회수") || combinedText.includes("해제") || combinedText.includes("완료")) {
      status = "복구완료";
    } else if (processDateRaw || resultText) {
      status = "복구완료";
    }

    results.push({
      openid: openid.trim(),
      country,
      platform,
      date: dateParsed,
      year, month, day,
      week: Math.ceil(day / 7),
      cancelOrderNo: get(row, ci.cancelOrderNo),
      cancelProduct: get(row, ci.cancelProduct),
      requestDate: get(row, ci.requestDate),
      ticketNo: get(row, ci.ticketNo),
      releaseDate: get(row, ci.releaseDate),
      rechargeOrderNo: get(row, ci.rechargeOrderNo),
      rechargeProduct: get(row, ci.rechargeProduct),
      rechargeAmount: parseAmount(get(row, ci.rechargeAmount)),
      processDate: processDateParsed || processDateRaw,
      processResult: displayResult || resultText,
      status,
      resanctioned,
    });
  }

  console.log(`✅ [${platform}] 최종 파싱: ${results.length}건 / 전체 ${allRows.length - 1}행`);
  return results;
}
