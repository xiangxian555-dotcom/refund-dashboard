import { google } from "googleapis";

const SHEET_ID = "1xySVvqx0DXiox8fkvMAr86WzP1hTdHzJuxf63iop6l8";

// Google Play 전용 — iOS 탭 제거
const SHEET_TABS = [
  { name: "한국_결제취소 악용 정상화(AOS)", country: "한국", platform: "Google" },
  { name: "일본_결제취소 악용 정상화(AOS)", country: "일본", platform: "Google" },
];

function parseDate(val) {
  if (!val) return "";
  const s = String(val).trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  return s.slice(0, 10);
}

// 마지막 줄 추출 (줄바꿈 분리)
function getLastLine(text) {
  if (!text) return "";
  const lines = text.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || "";
}

// ━━━ 한국 시트 분류 ━━━
// N열 or O열의 마지막 코멘트 기준
// ★ 수정: 제재/정지를 먼저 체크 → "uc회수 부족 제재" 같은 문구 오분류 방지
function classifyKorea(nText, oText) {
  // O열 우선, 없으면 N열
  const text = (oText && oText.trim() && oText.trim() !== "-") ? oText : nText;
  if (!text || !text.trim() || text.trim() === "-") return null; // 미처리 → null

  const lastLine = getLastLine(text);
  const checkText = lastLine || text;

  // ★ 제재/정지 계열을 먼저 체크 (회수보다 우선)
  if (/정지|제재|재정지|재제재/.test(checkText)) return "재제재";
  if (/회수완료|회수 완료|UC회수|uc회수|복구|해제|정상화|재충전/.test(checkText)) return "복구완료";
  // 단순 "회수" 단어도 복구완료 (제재 없는 경우)
  if (/회수/.test(checkText)) return "복구완료";

  // 마지막 줄에서 판단 안 되면 전체 텍스트도 확인
  if (/정지|제재|재정지|재제재/.test(text)) return "재제재";
  if (/회수/.test(text)) return "복구완료";

  return null;
}

// ━━━ 일본 시트 날짜 추출 ━━━
// Y열 코멘트에서 가장 마지막 날짜를 처리일로 사용
// 패턴: (2020/05/28), (20/05/28), (21/2/3), (25/07/16) 등
function extractJapanDate(yText) {
  if (!yText) return "";
  // 모든 날짜 패턴 추출
  const matches = [...yText.matchAll(/\((\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})\)/g)];
  if (!matches.length) return "";
  // 마지막 날짜 사용
  const last = matches[matches.length - 1];
  let year = last[1];
  // 2자리 연도 → 4자리 변환 (20→2020, 25→2025)
  if (year.length === 2) year = (parseInt(year) >= 18 ? "20" : "20") + year;
  const month = last[2].padStart(2, "0");
  const day = last[3].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ━━━ 일본 시트 분류 ━━━
// Y열 전체 코멘트 기준으로 최종 처리 결과 판단
// 재제재를 먼저 체크 (복구 후 재제재 케이스 대응)
function classifyJapan(yText) {
  if (!yText || !yText.trim()) return null;

  const normalized = yText.replace(/\r\n|\r|\n|\u000A|\u000D/g, "\n");
  const lines = normalized.split("\n").map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";

  // ★ 마지막 줄 기준으로 판단 (재제재 먼저)
  if (/BAN処理済み|再度BAN|期限が過ぎたためBAN|チャージがなかったため.*BAN|課金しないで停止|停止いたしました|再制裁/.test(lastLine)) return "재제재";
  if (/回収完了|回収いたしました|UCを回収|回収済み|回収を行った|回収案内|UC回収/.test(lastLine)) return "복구완료";

  // 마지막 줄에서 판단 안 되면 전체 텍스트에서 가장 마지막 결과 판단
  // 아래에서 위로 읽으면서 첫 번째 결과를 최종으로
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (/BAN処理済み|再度BAN|期限が過ぎたためBAN|チャージがなかったため.*BAN|課金しないで停止|停止いたしました|再制裁/.test(l)) return "재제재";
    if (/回収完了|回収いたしました|UCを回収|回収済み|回収を行った|回収案内|UC回収/.test(l)) return "복구완료";
  }

  return null;
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  // country 파라미터로 특정 국가만 로드 가능
  const countryFilter = req.query.country || null;

  try {
    const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: keyJson,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const allRows = [];

    const targetTabs = countryFilter
      ? SHEET_TABS.filter(t => t.country === countryFilter)
      : SHEET_TABS;

    for (const tab of targetTabs) {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: tab.name,
          valueRenderOption: "FORMATTED_VALUE",
        });

        const rows = response.data.values || [];
        console.log(`[${tab.name}] 로드된 행 수: ${rows.length}`);
        if (rows.length < 2) continue;

        const isJapan = tab.country === "일본";

        // ━━━ 한국 시트 파싱 ━━━
        if (!isJapan) {
          // 헤더 행 찾기 (1행 or 2행)
          let headerIdx = 0;
          for (let i = 0; i < Math.min(5, rows.length); i++) {
            if (rows[i].some(c => /openid|오픈|open/i.test(c || ""))) {
              headerIdx = i; break;
            }
          }
          const headers = rows[headerIdx];

          const findCol = (...names) => {
            for (const n of names) {
              const idx = headers.findIndex(h => new RegExp(n, "i").test(h || ""));
              if (idx >= 0) return idx;
            }
            return -1;
          };

          const ci = {
            openid: findCol("openid", "open id", "오픈") >= 0
              ? findCol("openid", "open id", "오픈") : 2,
            date: findCol("date", "날짜", "기간", "일시") >= 0
              ? findCol("date", "날짜", "기간", "일시") : 1,
            nCol: 13, // N열 (0-based index 13)
            oCol: 14, // O열 (0-based index 14)
          };

          for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const openid = String(row[ci.openid] || "").trim();
            if (!openid) continue;

            const nText = String(row[ci.nCol] || "").trim();
            const oText = String(row[ci.oCol] || "").trim();
            const status = classifyKorea(nText, oText);

            const dateRaw = String(row[ci.date] || "").trim();
            const date = parseDate(dateRaw);

            allRows.push({
              openid,
              country: tab.country,
              platform: tab.platform,
              date,
              year: date.slice(0, 4),
              month: date.slice(0, 7),
              resultText: oText || nText,
              status: status || "처리중",
              segment: `${tab.platform}_${tab.country}`,
            });
          }
        }

        // ━━━ 일본 시트 파싱 ━━━
        else {
          let headerIdx = 3;
          for (let i = 0; i < Math.min(10, rows.length); i++) {
            if (rows[i].some(c => /^open.?id$/i.test((c || "").trim()))) {
              headerIdx = i; break;
            }
          }
          const headers = rows[headerIdx];

          const findCol = (...names) => {
            for (const n of names) {
              const idx = headers.findIndex(h => new RegExp(n, "i").test((h || "").trim()));
              if (idx >= 0) return idx;
            }
            return -1;
          };

          const openidIdx = findCol("OPEN ID", "openid") >= 0 ? findCol("OPEN ID", "openid") : 4;
          const dateIdx = findCol("抽出期間", "期間") >= 0 ? findCol("抽出期間", "期間") : 1;
          const ci = { openid: openidIdx, date: dateIdx };

          let yColIdx = headers.length - 1;
          for (let c = headers.length - 1; c >= 0; c--) {
            if (headers[c] && headers[c].trim()) { yColIdx = c; break; }
          }
          for (let c = 0; c < headers.length; c++) {
            if (/コメント|comment/i.test((headers[c] || "").trim())) {
              yColIdx = c; break;
            }
          }
          console.log("[일본시트] 헤더수:", headers.length, "코멘트열:", yColIdx, "헤더:", headers[yColIdx]);

          for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const rawOid = row[ci.openid];
            if (!rawOid && rawOid !== 0) continue;
            const openid = String(rawOid).trim().replace(/\.0+$/, "");
            if (!openid) continue;
            const truncatedOid = openid.length >= 15 ? openid.slice(0, 15) : openid;

            const yText = String(row[yColIdx] || "").trim();
            const status = classifyJapan(yText);

            // Y열 코멘트에서 마지막 날짜 추출 (없으면 抽出期間 열 폴백)
            const dateFromComment = extractJapanDate(yText);
            const dateRaw = String(row[ci.date] || "").trim();
            const date = dateFromComment || parseDate(dateRaw) || "";

            allRows.push({
              openid,
              truncatedOid,
              country: tab.country,
              platform: tab.platform,
              date,
              year: date.slice(0, 4),
              month: date.slice(0, 7),
              resultText: yText,
              status: status || "처리중",
              segment: `${tab.platform}_${tab.country}`,
            });
          }
        }

      } catch (tabErr) {
        console.error(`시트 오류 (${tab.name}):`, tabErr.message);
      }
    }

    res.status(200).json({ success: true, data: allRows, count: allRows.length });
  } catch (err) {
    console.error("API 오류:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}
