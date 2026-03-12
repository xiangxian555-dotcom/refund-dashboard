import { google } from "googleapis";

const SHEET_ID = "1CGbeYMcL9DjTSw3AVbMtRXTy1-PpOE6HmuK0Ul1HIx0";

const SHEET_TABS = [
  { name: "한국_결제취소 악용 정상화(iOS)", country: "한국", platform: "Apple" },
  { name: "일본_결제취소 악용 정상화(iOS)", country: "일본", platform: "Apple" },
];

// countryFilter가 "ETC"이면 한국/일본 외 시트 없으므로 빈 배열 반환

function parseDate(val) {
  if (!val) return "";
  const s = String(val).trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  return s.slice(0, 10);
}

function getLastLine(text) {
  if (!text) return "";
  const lines = text.split(/\n|\r/).map(l => l.trim()).filter(Boolean);
  return lines[lines.length - 1] || "";
}

// ━━━ 한국 시트 분류 (iOS) ━━━
// Q열 기준 — 제재/정지를 먼저 체크
function classifyKorea(qText) {
  if (!qText || !qText.trim() || qText.trim() === "-") return null;
  const lastLine = getLastLine(qText);
  const checkText = lastLine || qText;

  if (/정지|제재|재정지|재제재/.test(checkText)) return "재제재";
  if (/회수완료|회수 완료|UC회수|uc회수|복구|해제|정상화|재충전/.test(checkText)) return "복구완료";
  if (/회수/.test(checkText)) return "복구완료";

  if (/정지|제재|재정지|재제재/.test(qText)) return "재제재";
  if (/회수/.test(qText)) return "복구완료";
  return null;
}

// ━━━ 일본 날짜 추출 ━━━
function extractJapanDate(yText) {
  if (!yText) return "";
  const matches = [...yText.matchAll(/\((\d{2,4})[\/\-](\d{1,2})[\/\-](\d{1,2})\)/g)];
  if (!matches.length) return "";
  const last = matches[matches.length - 1];
  let year = last[1];
  if (year.length === 2) year = "20" + year;
  const month = last[2].padStart(2, "0");
  const day = last[3].padStart(2, "0");
  return `${year}-${month}-${day}`;
}

// ━━━ 일본 시트 분류 (iOS) ━━━
// Y열 코멘트 기준 — 재제재 먼저 체크
function classifyJapan(yText) {
  if (!yText || !yText.trim()) return null;
  const normalized = yText.replace(/\r\n|\r|\n|\u000A|\u000D/g, "\n");
  const lines = normalized.split("\n").map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";

  if (/BAN処理済み|再度BAN|期限が過ぎたためBAN|チャージがなかったため.*BAN|課金しないで停止|停止いたしました|再制裁/.test(lastLine)) return "재제재";
  if (/回収完了|回収いたしました|UCを回収|回収済み|回収を行った|回収案内|UC回収/.test(lastLine)) return "복구완료";

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

  const countryFilter = req.query.country || null;

  // ETC는 한국 + 일본 시트 모두 로드 (KRW/JPY 외 통화 유저 포함)
  const targetTabs = countryFilter === "ETC"
    ? SHEET_TABS // 한국 + 일본 시트 모두
    : countryFilter
      ? SHEET_TABS.filter(t => t.country === countryFilter)
      : SHEET_TABS;

  try {
    const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
    const auth = new google.auth.GoogleAuth({
      credentials: keyJson,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const allRows = [];

    for (const tab of targetTabs) {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: tab.name,
          valueRenderOption: "FORMATTED_VALUE",
        });

        const rows = response.data.values || [];
        console.log(`[iOS][${tab.name}] 로드된 행 수: ${rows.length}`);
        if (rows.length < 2) continue;

        const isJapan = tab.country === "일본";

        // ━━━ 한국 시트 파싱 ━━━
        if (!isJapan) {
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
            openid: findCol("openid","open id","오픈") >= 0 ? findCol("openid","open id","오픈") : 2,
            date:   findCol("date","날짜","기간","일시") >= 0 ? findCol("date","날짜","기간","일시") : 1,
            qCol:   16, // Q열 (0-based index 16) — iOS 처리결과
          };

          for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const openid = String(row[ci.openid] || "").trim();
            if (!openid) continue;

            const qText = String(row[ci.qCol] || "").trim();
            const status = classifyKorea(qText);

            const dateRaw = String(row[ci.date] || "").trim();
            const date = parseDate(dateRaw);

            allRows.push({
              openid,
              country: tab.country,
              platform: tab.platform,
              date,
              year: date.slice(0, 4),
              month: date.slice(0, 7),
              resultText: qText,
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

          const openidIdx = findCol("OPEN ID","openid") >= 0 ? findCol("OPEN ID","openid") : 4;
          const ci = { openid: openidIdx };

          // Y열(코멘트) 찾기
          let yColIdx = headers.length - 1;
          for (let c = headers.length - 1; c >= 0; c--) {
            if (headers[c] && headers[c].trim()) { yColIdx = c; break; }
          }
          for (let c = 0; c < headers.length; c++) {
            if (/コメント|comment/i.test((headers[c] || "").trim())) {
              yColIdx = c; break;
            }
          }

          for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const rawOid = row[ci.openid];
            if (!rawOid && rawOid !== 0) continue;
            const openid = String(rawOid).trim().replace(/\.0+$/, "");
            if (!openid) continue;
            const truncatedOid = openid.length >= 15 ? openid.slice(0, 15) : openid;

            const yText = String(row[yColIdx] || "").trim();
            const status = classifyJapan(yText);

            const date = extractJapanDate(yText);
            if (!date) continue;

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
        console.error(`[iOS] 시트 오류 (${tab.name}):`, tabErr.message);
      }
    }

    res.status(200).json({ success: true, data: allRows, count: allRows.length });
  } catch (err) {
    console.error("[iOS] API 오류:", err);
    res.status(500).json({ success: false, error: err.message });
  }
}
