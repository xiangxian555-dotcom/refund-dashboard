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
// Y열 전체 텍스트 기준 (줄바꿈 처리 포함)
// "回収" 포함 → 복구완료
// "BAN" or "停止" 포함 → 재제재
function classifyJapan(yText) {
  if (!yText || !yText.trim()) return null;

  // 줄바꿈 정규화 (\n, \r, 유니코드 줄바꿈 모두 처리)
  const normalized = yText.replace(/\r\n|\r|\n|\u000A|\u000D/g, "\n");
  const lines = normalized.split("\n").map(l => l.trim()).filter(Boolean);
  const lastLine = lines[lines.length - 1] || "";
  const fullText = normalized;

  // 마지막 줄 우선 판단
  if (/回収/.test(lastLine)) return "복구완료";
  if (/BAN|停止|再制裁/.test(lastLine)) return "재제재";

  // 전체 텍스트에서 판단 (마지막 줄에 없을 경우)
  // 回収完了 관련 표현
  if (/回収完了|回収完了案内|回収いたしました|UCの回収|uc.*回収|回收完了|回收案内/.test(fullText)) return "복구완료";
  // BAN/停止 관련 표현
  if (/BANいたしました|BAN処理|再度BAN|停止いたしました|期限.*BAN/.test(fullText)) return "재제재";

  // 전체에 回収 있으면 복구완료
  if (/回収|回收/.test(fullText)) return "복구완료";
  if (/BAN|停止/.test(fullText)) return "재제재";

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

          // 전체 행 저장 (중복 제거 없음 — 히스토리 전체 보존)
          for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const openid = String(row[ci.openid] || "").trim();
            if (!openid) continue;

            const nText = String(row[ci.nCol] || "").trim();
            const oText = String(row[ci.oCol] || "").trim();
            const status = classifyKorea(nText, oText);

            // 처리 결과 없는 행도 저장 (히스토리 조회용) — null이면 "처리중"
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
        // 구조: 1~2행 타이틀, 3행 대분류, 4행 실제헤더, 5행~ 데이터
        // E열(4) = OPEN ID, B열(1) = 抽出期間, Y열(24) = コメント
        else {
          // 헤더 행 찾기 — "OPEN ID" 텍스트가 있는 행
          let headerIdx = 3; // 기본값: 4행(0-based: 3)
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

          // E열(index 4) = OPEN ID, B열(index 1) = 抽出期間
          const openidIdx = findCol("OPEN ID", "openid") >= 0 ? findCol("OPEN ID", "openid") : 4;
          const dateIdx = findCol("抽出期間", "期間") >= 0 ? findCol("抽出期間", "期間") : 1;

          const ci = { openid: openidIdx, date: dateIdx };

          // コメント 열 찾기 — 헤더에서 동적으로 찾고, 없으면 마지막 열 사용
          let yColIdx = headers.length - 1; // 기본값: 마지막 열
          // 마지막 비어있지 않은 열 찾기
          for (let c = headers.length - 1; c >= 0; c--) {
            if (headers[c] && headers[c].trim()) { yColIdx = c; break; }
          }
          // コメント 헤더 있으면 그걸 우선 사용
          for (let c = 0; c < headers.length; c++) {
            if (/コメント|comment/i.test((headers[c] || "").trim())) {
              yColIdx = c; break;
            }
          }
          console.log("[일본시트] 헤더수:", headers.length, "코멘트열:", yColIdx, "헤더:", headers[yColIdx]);

          // 처음 3개 OpenID 로그 (디버깅용)
          let debugCount = 0;

          // 전체 행 저장 (중복 제거 없음 — 히스토리 전체 보존)
          for (let i = headerIdx + 1; i < rows.length; i++) {
            const row = rows[i];
            const openid = String(row[ci.openid] || "").trim();
            if (!openid) continue;

            if (debugCount < 3) {
              console.log("[일본OpenID]", debugCount, "raw:", row[ci.openid], "→ string:", openid);
              debugCount++;
            }

            const yText = String(row[yColIdx] || "").trim();
            const status = classifyJapan(yText);

            const dateRaw = String(row[ci.date] || "").trim();
            const date = parseDate(dateRaw);

            allRows.push({
              openid,
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
