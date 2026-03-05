import { google } from "googleapis";

const SHEET_ID = "1xySVvqx0DXiox8fkvMAr86WzP1hTdHzJuxf63iop6l8";

const SHEET_TABS = [
  { name: "한국_결제취소 악용 정상화(AOS)", country: "한국", platform: "Google" },
  { name: "한국_결제취소 악용 정상화(iOS)", country: "한국", platform: "iOS" },
  { name: "일본_[Google] 決済悪用", country: "일본", platform: "Google" },
  { name: "일본_[Apple] 決済悪用", country: "일본", platform: "iOS" },
];

function parseDate(val) {
  if (!val) return "";
  const s = String(val).trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  return s.slice(0, 10);
}

function classifyStatus(text) {
  if (!text || !text.trim()) return "처리중";
  if (/회수|해제|복구|완료|정상화|재충전|再チャージ|回収|解除/.test(text)) return "복구완료";
  if (/제재|정지|ban|밴|再制裁|BAN|않음|미결제|なし|하지.*않/.test(text)) return "재제재";
  if (text.trim() && text.trim() !== "-") return "복구완료";
  return "처리중";
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  try {
    // 서비스 계정 JSON 파싱
    const keyJson = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);

    const auth = new google.auth.GoogleAuth({
      credentials: keyJson,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheets = google.sheets({ version: "v4", auth });
    const allRows = [];

    for (const tab of SHEET_TABS) {
      try {
        const response = await sheets.spreadsheets.values.get({
          spreadsheetId: SHEET_ID,
          range: tab.name,
        });

        const rows = response.data.values || [];
        if (rows.length < 2) continue;

        // 헤더 찾기
        let headerIdx = 0;
        for (let i = 0; i < Math.min(8, rows.length); i++) {
          if (rows[i].some(c => /openid|オープン|キャラ|캐릭/i.test(c || ""))) {
            headerIdx = i;
            break;
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
          openid: findCol("openid", "オープン", "キャラ", "캐릭"),
          date: findCol("期間", "기간", "抽出", "추출", "date"),
          abuseCount: findCol("악용 횟수", "悪用", "回数", "횟수"),
          totalUC: findCol("獲得", "획득.*UC", "누적"),
          currentUC: findCol("保有", "보유.*UC", "현재"),
          amount: findCol("金額", "금액"),
        };

        // 마지막 컬럼을 result로
        let resultIdx = headers.length - 1;
        for (let c = headers.length - 1; c >= 0; c--) {
          if (headers[c] && headers[c].trim()) { resultIdx = c; break; }
        }

        for (let i = headerIdx + 1; i < rows.length; i++) {
          const row = rows[i];
          const openid = (row[ci.openid] || "").trim();
          if (!openid) continue;

          const resultText = (row[resultIdx] || "").trim();
          const status = classifyStatus(resultText);
          const dateRaw = ci.date >= 0 ? (row[ci.date] || "") : "";
          const date = parseDate(dateRaw);

          allRows.push({
            openid,
            country: tab.country,
            platform: tab.platform,
            date,
            year: date.slice(0, 4),
            month: date.slice(0, 7),
            abuseCount: parseFloat((row[ci.abuseCount] || "0").toString().replace(/,/g, "")) || 0,
            totalUC: parseFloat((row[ci.totalUC] || "0").toString().replace(/,/g, "")) || 0,
            currentUC: parseFloat((row[ci.currentUC] || "0").toString().replace(/,/g, "")) || 0,
            amount: Math.abs(parseFloat((row[ci.amount] || "0").toString().replace(/,/g, "")) || 0),
            resultText,
            status,
            segment: `${tab.platform}_${tab.country}`,
          });
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
