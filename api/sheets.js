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
// "회수" 포함 → 복구완료
// "정지" or "제재" 포함 → 재제재
function classifyKorea(nText, oText) {
  // O열 우선, 없으면 N열
  const text = (oText && oText.trim() && oText.trim() !== "-") ? oText : nText;
  if (!text || !text.trim() || text.trim() === "-") return null; // 미처리 → null
  const lastLine = getLastLine(text);
  const checkText = lastLine || text;

  if (/회수/.test(checkText)) return "복구완료";
  if (/정지|제재/.test(checkText)) return "재제재";
  // 전체 텍스트도 확인
  if (/회수/.test(text)) return "복구완료";
  if (/정지|제재/.test(text)) return "재제재";
  return null;
}

// ━━━ 일본 시트 분류 ━━━
// Y열 마지막 줄 기준
// "回収" 포함 → 복구완료
// "BAN" or "停止" 포함 → 재제재
function classifyJapan(yText) {
  if (!yText || !yText.trim()) return null;
  const lastLine = getLastLine(yText);
  const checkText = lastLine || yText;

  if (/回収/.test(checkText)) return "복구완료";
  if (/BAN|停止/.test(checkText)) return "재제재";
  // 전체 텍스트도 확인
  if (/回収/.test(yText)) return "복구완료";
  if (/BAN|停止/.test(yText)) return "재제재";
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

          // C열(openid), B열(date), N열(처리날짜/코멘트), O열(처리결과)
          const findCol = (...names) => {
            for (const n of names) {
              const idx = headers.findIndex(h => new RegExp(n, "i").test(h || ""));
              if (idx >= 0) return idx;
            }
            return -1;
          };

          const ci = {
            openid: findCol("openid", "open id", "오픈") >= 0
              ? findCol("openid", "open id", "오픈") : 2, // C열 기본값
            date: findCol("date", "날짜", "기간", "일시") >= 0
              ? findCol("date", "날짜", "기간", "일시") : 1, // B열 기본값
            nCol: 13, // N열 (0-based index 13)
            oCol: 14, // O열 (0-based index 14)
          };

          // OpenID별 마지막 행만 유지 (중복 제거)
          const koreaMap = {}; // openid → {status, date, resultText}
          for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const openid = String(row[ci.openid] || "").trim();
            if (!openid) continue;

            const nText = String(row[ci.nCol] || "").trim();
            const oText = String(row[ci.oCol] || "").trim();
            const status = classifyKorea(nText, oText);

            // 처리 결과가 있는 행만 저장 (마지막 행으로 덮어씀)
            if (!status) continue;

            const dateRaw = String(row[ci.date] || "").trim();
            const date = parseDate(dateRaw);

            koreaMap[openid] = {
              openid,
              country: tab.country,
              platform: tab.platform,
              date,
              year: date.slice(0, 4),
              month: date.slice(0, 7),
              resultText: oText || nText,
              status,
              segment: `${tab.platform}_${tab.country}`,
            };
          }
          // 중복 제거된 결과를 allRows에 추가
          Object.values(koreaMap).forEach(r => allRows.push(r));
        }

        // ━━━ 일본 시트 파싱 ━━━
        else {
          // 헤더 행 찾기 (4행에 헤더 있음)
          let headerIdx = 0;
          for (let i = 0; i < Math.min(8, rows.length); i++) {
            if (rows[i].some(c => /openid|オープン|OPEN|open/i.test(c || ""))) {
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
            // E열(index 4) = OPEN ID
            openid: findCol("OPEN ID", "openid", "オープン") >= 0
              ? findCol("OPEN ID", "openid", "オープン") : 4,
            // B열(index 1) = 抽出期間
            date: findCol("抽出期間", "期間", "date", "기간") >= 0
              ? findCol("抽出期間", "期間", "date", "기간") : 1,
          };

          // Y열 = コメント (index 24) — 동적으로 찾기
          let yColIdx = 24;
          for (let c = 0; c < headers.length; c++) {
            if (/コメント|comment/i.test(headers[c] || "")) {
              yColIdx = c; break;
            }
          }

          // OpenID별 마지막 행만 유지 (중복 제거)
          const japanMap = {};
          for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const openid = String(row[ci.openid] || "").trim();
            if (!openid) continue;

            const yText = String(row[yColIdx] || "").trim();
            const status = classifyJapan(yText);

            // 처리 결과가 있는 행만 저장 (마지막 행으로 덮어씀)
            if (!status) continue;

            const dateRaw = String(row[ci.date] || "").trim();
            const date = parseDate(dateRaw);

            japanMap[openid] = {
              openid,
              country: tab.country,
              platform: tab.platform,
              date,
              year: date.slice(0, 4),
              month: date.slice(0, 7),
              resultText: yText,
              status,
              segment: `${tab.platform}_${tab.country}`,
            };
          }
          // 중복 제거된 결과를 allRows에 추가
          Object.values(japanMap).forEach(r => allRows.push(r));
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
