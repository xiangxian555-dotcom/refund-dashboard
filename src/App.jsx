import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line } from "recharts";
import * as XLSX from "xlsx";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 상수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const fmt = n => (n || 0).toLocaleString();
const TT = { contentStyle: { background: "#060d18", border: "1px solid #1e3a5f", borderRadius: 8, fontSize: 11 } };
const SHEET_ID = "1xySVvqx0DXiox8fkvMAr86WzP1hTdHzJuxf63iop6l8";
const TABS = ["전체 현황", "연도별 분석", "세그먼트", "대응 현황", "유저 조회", "AI 분석"];

const GSHEET_TARGETS = [
  { label: "한국 AOS", country: "한국", platform: "Google", gid: "0" },
  { label: "한국 iOS", country: "한국", platform: "iOS", gid: "123906372" },
  { label: "일본 Google", country: "일본", platform: "Google", gid: "1689075940" },
  { label: "일본 Apple", country: "일본", platform: "iOS", gid: "849352972" },
];

const CURRENCY_COUNTRY = { KRW: "한국", JPY: "일본" };
const SEG_COLORS = {
  "Google_한국": "#3b82f6", "Google_일본": "#06b6d4", "Google_기타": "#6366f1",
  "iOS_한국": "#a855f7", "iOS_일본": "#ec4899", "iOS_기타": "#f59e0b",
};
const STATUS_COLORS = { "복구완료": "#22c55e", "재제재": "#ef4444", "처리중": "#f59e0b" };

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseDate(val) {
  if (!val) return null;
  const s = String(val).trim();
  const m = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2,"0")}-${m[3].padStart(2,"0")}`;
  const num = parseFloat(s);
  if (!isNaN(num) && num > 40000) {
    const d = new Date((num - 25569) * 86400 * 1000);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }
  return null;
}

function parseNum(v) {
  if (!v && v !== 0) return 0;
  return parseFloat(String(v).replace(/,/g,"").trim()) || 0;
}

function getCountry(currency) {
  return CURRENCY_COUNTRY[String(currency||"").trim().toUpperCase()] || "기타";
}

function getSeg(platform, country) { return `${platform}_${country}`; }

function detectPlatform(sheetName) {
  const s = sheetName.toLowerCase();
  if (s.includes("ios") || s.includes("apple") || s.includes("앱스토어")) return "iOS";
  if (s.includes("google") || s.includes("aos") || s.includes("구글")) return "Google";
  return null;
}

function detectCountry(sheetName) {
  const s = sheetName;
  if (/일본|japan|jp|日本/i.test(s)) return "일본";
  if (/한국|korea|kr|韓国/i.test(s)) return "한국";
  return null;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 엑셀 파일 파싱 — 시트명으로 자동 인식
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseExcelFile(wb) {
  const orderRows = [];   // 주문번호 시트 (결제취소 악용 대상자 OrderID)
  const abuseRows = [];   // 악용자 리스트 (결제취소 악용자 리스트)
  const log = [];

  wb.SheetNames.forEach(sName => {
    const ws = wb.Sheets[sName];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: "", header: 1 });
    if (!raw || raw.length < 2) return;

    // 헤더 행 찾기 (OPENID 또는 주문번호가 있는 행)
    let headerIdx = 0;
    for (let i = 0; i < Math.min(5, raw.length); i++) {
      const row = raw[i].map(c => String(c||"").toLowerCase());
      if (row.some(c => c.includes("openid") || c.includes("오픈") || c.includes("주문번호") || c.includes("order"))) {
        headerIdx = i; break;
      }
    }
    const headers = raw[headerIdx].map(c => String(c||"").trim());
    const findCol = (...names) => {
      for (const n of names) {
        const idx = headers.findIndex(h => new RegExp(n, "i").test(h));
        if (idx >= 0) return idx;
      }
      return -1;
    };

    const sLower = sName.toLowerCase();

    // ── 주문번호 시트 (결제취소 악용 대상자 OrderID) ──
    if (sLower.includes("orderid") || sLower.includes("주문번호") || sLower.includes("order")) {
      const ci = {
        orderNo: findCol("주문번호","order number","order"),
        openid: findCol("오픈 아이디","openid","오픈아이디","open id"),
        currency: findCol("화폐","currency","통화"),
        ucBalance: findCol("uc잔액","uc 잔액","잔액"),
        time: findCol("시간","time","날짜","date"),
      };
      let parsed = 0;
      for (let i = headerIdx + 1; i < raw.length; i++) {
        const row = raw[i];
        const orderNo = String(row[ci.orderNo] || "").trim();
        const openid = String(row[ci.openid] || "").trim();
        if (!orderNo && !openid) continue;
        const currency = String(row[ci.currency] || "KRW").trim().toUpperCase();
        const country = getCountry(currency);
        // 플랫폼은 주문번호로 판단 (GPA = Google, 없으면 시트명)
        const platform = orderNo.startsWith("GPA") ? "Google" :
                         (detectPlatform(sName) || "Google");
        const dateRaw = row[ci.time];
        const date = parseDate(String(dateRaw||"")) || String(dateRaw||"").slice(0,10);
        orderRows.push({
          orderNo, openid, currency, country, platform,
          date, year: date.slice(0,4), month: date.slice(0,7),
          ucBalance: parseNum(row[ci.ucBalance]),
          segment: getSeg(platform, country),
        });
        parsed++;
      }
      log.push({ sheet: sName, type: "주문", count: parsed });
    }

    // ── 악용자 리스트 시트 ──
    else if (sLower.includes("악용자") || sLower.includes("리스트") || sLower.includes("list")) {
      const ci = {
        currency: findCol("화폐","currency"),
        openid: findCol("openid","오픈","open id"),
        abuseCount: findCol("악용 횟수","악용횟수","횟수"),
        totalUC: findCol("누적 획득","누적획득","獲得"),
        currentUC: findCol("현재 보유","현재보유","保有"),
        pValue: findCol("p값","p 값","누적.*현재"),
        result: findCol("회수","제재","결과","처리"),
        note: findCol("비고","note","구글독스"),
      };

      // 마지막 텍스트 컬럼 자동 탐지 (result fallback)
      if (ci.result < 0) {
        for (let c = headers.length - 1; c >= 0; c--) {
          if (headers[c] && headers[c].trim()) { ci.result = c; break; }
        }
      }

      let parsed = 0;
      for (let i = headerIdx + 1; i < raw.length; i++) {
        const row = raw[i];
        const openid = String(row[ci.openid] || "").trim();
        if (!openid) continue;

        const currency = String(row[ci.currency] || "KRW").trim().toUpperCase();
        const country = getCountry(currency);
        const platform = detectPlatform(sName) || "Google";
        const resultText = String(row[ci.result] || "").trim();
        const pValue = parseNum(row[ci.pValue]);

        let action = "미정";
        if (/회수/.test(resultText)) action = "회수";
        else if (/제재|정지|ban/i.test(resultText)) action = "제재";
        else if (resultText && resultText !== "-") action = pValue >= 0 ? "회수" : "제재";
        else action = pValue >= 0 ? "회수" : "제재";

        abuseRows.push({
          openid, currency, country, platform,
          abuseCount: parseNum(row[ci.abuseCount]),
          totalUC: parseNum(row[ci.totalUC]),
          currentUC: parseNum(row[ci.currentUC]),
          pValue, resultText, action,
          segment: getSeg(platform, country),
        });
        parsed++;
      }
      log.push({ sheet: sName, type: "악용자", count: parsed });
    }
  });

  // orderRows에서 openid→country/platform 매핑 보완
  // (주문번호 시트의 화폐로 국가 확정)
  const oidInfo = {};
  orderRows.forEach(o => {
    if (o.openid && !oidInfo[o.openid]) {
      oidInfo[o.openid] = { country: o.country, platform: o.platform, currency: o.currency };
    }
  });

  return { orderRows, abuseRows, oidInfo, log };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CSV 파싱 (Google Sheets)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseCSV(text) {
  const rows = [];
  let cur = "", inQ = false;
  const chars = text.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch==='"') { if(inQ&&chars[i+1]==='"'){cur+='"';i++;}else inQ=!inQ; }
    else if (ch==='\n'&&!inQ) { rows.push(cur); cur=""; }
    else cur+=ch;
  }
  if (cur.trim()) rows.push(cur);
  return rows.map(row => {
    const fields=[]; let field="",inq=false;
    for (let i=0;i<row.length;i++) {
      const c=row[i];
      if(c==='"'){if(inq&&row[i+1]==='"'){field+='"';i++;}else inq=!inq;}
      else if(c===','&&!inq){fields.push(field.trim());field="";}
      else field+=c;
    }
    fields.push(field.trim());
    return fields;
  });
}

function parseGSheetCSV(text, country, platform) {
  const allRows = parseCSV(text);
  if (allRows.length < 3) return [];

  // 헤더 행 탐색
  let headerIdx = 0;
  for (let i = 0; i < Math.min(8, allRows.length); i++) {
    if (allRows[i].some(c => /openid|open.id|オープン|캐릭|キャラ/i.test(c||""))) {
      headerIdx = i; break;
    }
  }
  const headers = allRows[headerIdx];
  const findCol = (...names) => {
    for (const n of names) {
      const idx = headers.findIndex(h => new RegExp(n,"i").test(h||""));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const ci = {
    openid: findCol("openid","open.id","オープン","キャラ","캐릭"),
    date: findCol("期間","기간","抽出","추출","date","날짜"),
    abuseCount: findCol("악용 횟수","悪用","回数","횟수"),
    totalUC: findCol("獲得","획득.*UC","누적"),
    currentUC: findCol("保有","보유.*UC","현재"),
    amount: findCol("金額","금액","amount"),
  };

  // 마지막 컬럼을 result로
  let resultIdx = headers.length - 1;
  for (let c = headers.length - 1; c >= 0; c--) {
    if (headers[c] && headers[c].trim()) { resultIdx = c; break; }
  }

  const get = (row, idx) => (idx >= 0 && idx < row.length) ? (row[idx]||"").trim() : "";
  const results = [];

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || row.every(c => !c||c.trim()==="")) continue;
    const openid = get(row, ci.openid);
    if (!openid) continue;

    const resultText = get(row, resultIdx);
    let status = "처리중";
    if (/회수|해제|복구|완료|정상화|재충전|再チャージ|回収|解除/.test(resultText)) status = "복구완료";
    else if (/제재|정지|ban|밴|再制裁|BAN|않음|미결제|なし|하지.*않/.test(resultText)) status = "재제재";
    else if (resultText && resultText !== "-" && resultText.length > 0) status = "복구완료";

    const dateRaw = get(row, ci.date);
    const date = parseDate(dateRaw) || dateRaw.slice(0,10) || "";

    results.push({
      openid, country, platform,
      date, year: date.slice(0,4), month: date.slice(0,7),
      abuseCount: parseNum(get(row, ci.abuseCount)),
      totalUC: parseNum(get(row, ci.totalUC)),
      currentUC: parseNum(get(row, ci.currentUC)),
      amount: Math.abs(parseNum(get(row, ci.amount))),
      resultText, status,
      segment: getSeg(platform, country),
    });
  }
  return results;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UI 컴포넌트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const Card = ({ icon, label, value, sub, color="#3b82f6" }) => (
  <div style={{ background:"linear-gradient(135deg,#0d1b2e,#0a1220)", borderRadius:14, padding:"16px 18px", border:`1px solid ${color}33`, borderLeft:`4px solid ${color}`, position:"relative", overflow:"hidden" }}>
    <div style={{ position:"absolute", top:-10, right:-10, width:70, height:70, background:`radial-gradient(circle,${color}18,transparent 70%)`, borderRadius:"50%" }}/>
    <div style={{ fontSize:10, color:"#2d4a6e", marginBottom:5, textTransform:"uppercase", letterSpacing:"0.06em" }}>{icon} {label}</div>
    <div style={{ fontSize:24, fontWeight:800, color, lineHeight:1 }}>{value}</div>
    {sub && <div style={{ fontSize:10, color:"#2d4a6e", marginTop:5 }}>{sub}</div>}
  </div>
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 메인 앱
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [tab, setTab] = useState("전체 현황");
  const [yearFilter, setYearFilter] = useState("전체");
  const [segFilter, setSegFilter] = useState("전체");

  // 엑셀 데이터 (파일 2개: Google/iOS 각각)
  const [files, setFiles] = useState([]); // [{name, orderRows, abuseRows, oidInfo, log}]
  const [uploadLog, setUploadLog] = useState([]);

  // Google Sheets 대응현황
  const [responseData, setResponseData] = useState([]);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetErr, setSheetErr] = useState("");
  const [sheetStatus, setSheetStatus] = useState([]);
  const [lastFetch, setLastFetch] = useState("");

  // AI 채팅
  const [chatMessages, setChatMessages] = useState([
    { role:"assistant", content:"안녕하세요! 결제취소 악용자 대응현황을 분석해드립니다 😊\n\n예시 질문:\n• 2026년 구글 한국 주문건수 몇 건이에요?\n• 일본 유저 중 제재된 사람 몇 명이에요?\n• 복구 완료율이 어떻게 돼요?\n• 전체 회수 vs 제재 비율 알려줘" }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // 유저 조회
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState(null);

  // ── 파일 업로드 ──
  const handleFile = useCallback(async (file) => {
    if (!file) return;
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab);
      const parsed = parseExcelFile(wb);
      setFiles(prev => {
        // 같은 파일명이면 교체, 아니면 추가 (최대 2개)
        const existing = prev.findIndex(f => f.name === file.name);
        const entry = { name: file.name, ...parsed };
        if (existing >= 0) { const n=[...prev]; n[existing]=entry; return n; }
        return [...prev.slice(-1), entry]; // 최대 2개 유지
      });
      setUploadLog(parsed.log);
    } catch(e) { alert("파싱 오류: " + e.message); }
  }, []);

  // ── Google Sheets 불러오기 (API Route 방식) ──
  const fetchSheets = useCallback(async () => {
    setSheetLoading(true); setSheetErr(""); setSheetStatus([]);
    try {
      const res = await fetch("/api/sheets");
      const data = await res.json();
      if (data.success && data.data.length > 0) {
        setResponseData(data.data);
        setLastFetch(new Date().toLocaleTimeString());
        // 시트별 카운트
        const log = GSHEET_TARGETS.map(cfg => {
          const count = data.data.filter(d => d.platform === cfg.platform && d.country === cfg.country).length;
          return { label: cfg.label, count, ok: count > 0 };
        });
        setSheetStatus(log);
      } else {
        setSheetErr(data.error || "데이터를 불러오지 못했어요.");
      }
    } catch(e) {
      setSheetErr("API 오류: " + e.message);
    }
    setSheetLoading(false);
  }, []);

  // ── 전체 데이터 통합 ──
  const allOrderRows = useMemo(() => files.flatMap(f => f.orderRows), [files]);
  const allAbuseRows = useMemo(() => files.flatMap(f => f.abuseRows), [files]);
  const allOidInfo = useMemo(() => {
    const map = {};
    files.forEach(f => Object.assign(map, f.oidInfo));
    return map;
  }, [files]);

  // ── 필터 ──
  const years = useMemo(() => {
    const ys = [...new Set(allOrderRows.map(d=>d.year))].filter(Boolean).sort();
    return ["전체", ...ys];
  }, [allOrderRows]);

  const filtered = useMemo(() => allOrderRows.filter(d => {
    if (yearFilter!=="전체" && d.year!==yearFilter) return false;
    if (segFilter!=="전체" && d.segment!==segFilter) return false;
    return true;
  }), [allOrderRows, yearFilter, segFilter]);

  const filteredResp = useMemo(() => responseData.filter(d => {
    if (yearFilter!=="전체" && d.year!==yearFilter) return false;
    if (segFilter!=="전체" && d.segment!==segFilter) return false;
    return true;
  }), [responseData, yearFilter, segFilter]);

  // ── 핵심 통계 ──
  const stats = useMemo(() => {
    const totalOrders = filtered.length;
    const uniqueUsers = new Set(filtered.map(d=>d.openid).filter(Boolean)).size;
    const totalAmount = filtered.reduce((s,d)=>s+d.ucBalance,0);

    // 악용자 리스트 기준
    const totalAbuse = allAbuseRows.length;
    const recovered = allAbuseRows.filter(a=>a.action==="회수").length;
    const sanctioned = allAbuseRows.filter(a=>a.action==="제재").length;

    // 대응현황 (Google Sheets) 기준
    const oidMap = {};
    [...filteredResp].sort((a,b)=>a.date.localeCompare(b.date)).forEach(d=>{
      if(!oidMap[d.openid]) oidMap[d.openid]={status:d.status,lastDate:d.date};
      if(d.date>=oidMap[d.openid].lastDate){oidMap[d.openid].status=d.status;oidMap[d.openid].lastDate=d.date;}
    });
    const ids = Object.values(oidMap);
    const respRecovered = ids.filter(d=>d.status==="복구완료").length;
    const respResanctioned = ids.filter(d=>d.status==="재제재").length;
    const respProcessing = ids.filter(d=>d.status==="처리중").length;
    const totalResp = ids.length;

    // 세그먼트별
    const segStats = {};
    filtered.forEach(d => { segStats[d.segment]=(segStats[d.segment]||0)+1; });

    return { totalOrders, uniqueUsers, totalAmount, totalAbuse, recovered, sanctioned, respRecovered, respResanctioned, respProcessing, totalResp, segStats };
  }, [filtered, allAbuseRows, filteredResp]);

  // ── 연도별 차트 ──
  const yearlyChart = useMemo(() => {
    const g = {};
    allOrderRows.forEach(d => {
      if (!d.year) return;
      if (!g[d.year]) g[d.year] = { year:d.year, "Google·한국":0, "Google·일본":0, "iOS·한국":0, "iOS·일본":0, "기타":0 };
      const k = `${d.platform}·${d.country}`;
      if (g[d.year][k]!==undefined) g[d.year][k]++;
      else g[d.year]["기타"]++;
    });
    return Object.values(g).sort((a,b)=>a.year.localeCompare(b.year));
  }, [allOrderRows]);

  const monthlyChart = useMemo(() => {
    const src = yearFilter==="전체" ? allOrderRows : filtered;
    const g = {};
    src.forEach(d => {
      if (!d.month) return;
      if (!g[d.month]) g[d.month]={month:d.month, Google:0, iOS:0};
      g[d.month][d.platform]++;
    });
    return Object.values(g).sort((a,b)=>a.month.localeCompare(b.month));
  }, [allOrderRows, filtered, yearFilter]);

  const respTrend = useMemo(() => {
    const g = {};
    filteredResp.forEach(d => {
      const k = d.month||d.year;
      if (!k) return;
      if (!g[k]) g[k]={month:k, 복구완료:0, 재제재:0, 처리중:0};
      g[k][d.status]++;
    });
    return Object.values(g).sort((a,b)=>a.month.localeCompare(b.month));
  }, [filteredResp]);

  // ── AI 채팅 ──
  const sendChat = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg||chatLoading) return;
    setChatInput("");
    setChatMessages(prev=>[...prev,{role:"user",content:msg}]);
    setChatLoading(true);

    const ctx = {
      파일업로드: files.map(f=>({이름:f.name, 주문건수:f.orderRows.length, 악용자수:f.abuseRows.length})),
      전체주문건수: allOrderRows.length,
      유니크유저: stats.uniqueUsers,
      연도별: Object.fromEntries(yearlyChart.map(d=>[d.year+"년", Object.entries(d).filter(([k])=>k!=="year").reduce((s,[,v])=>s+v,0)])),
      세그먼트별: stats.segStats,
      악용자리스트: { 전체:stats.totalAbuse, 회수:stats.recovered, 제재:stats.sanctioned },
      대응현황GoogleSheets: { 전체:stats.totalResp, 복구완료:stats.respRecovered, 재제재:stats.respResanctioned, 처리중:stats.respProcessing },
    };

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          model:"claude-sonnet-4-20250514",
          max_tokens:1000,
          system:`당신은 PUBG Mobile 결제취소 악용자 대응 데이터 분석 어시스턴트입니다.
현재 대시보드 데이터:
${JSON.stringify(ctx,null,2)}

데이터 설명:
- 파일 업로드: 엑셀 파일 (주문번호 시트 + 악용자 리스트 시트)
- 세그먼트: Google/iOS × 한국(KRW)/일본(JPY)/기타
- 회수: UC잔액 있어서 회수 처리 (계정 유지)
- 제재: UC 사용해서 계정 정지
- 복구완료(Google Sheets): 재결제 후 계정 해제
- 재제재(Google Sheets): 재결제 안해서 다시 정지
- 처리중(Google Sheets): 아직 처리 안됨

한국어로 간결하게 답변해주세요.`,
          messages:[...chatMessages.slice(1), {role:"user",content:msg}]
        })
      });
      const data = await res.json();
      setChatMessages(prev=>[...prev,{role:"assistant",content:data.content?.[0]?.text||"응답 오류"}]);
    } catch(e) {
      setChatMessages(prev=>[...prev,{role:"assistant",content:"오류: "+e.message}]);
    }
    setChatLoading(false);
  }, [chatInput, chatLoading, chatMessages, files, allOrderRows, yearlyChart, stats]);

  useEffect(()=>{ chatEndRef.current?.scrollIntoView({behavior:"smooth"}); },[chatMessages]);

  // ── 유저 조회 ──
  const doSearch = () => {
    const q = searchQ.trim();
    if (!q) return;
    const orders = allOrderRows.filter(d=>d.openid.includes(q)||d.orderNo.includes(q));
    const abuse = allAbuseRows.find(a=>a.openid.includes(q));
    const history = responseData.filter(d=>d.openid.includes(q)).sort((a,b)=>a.date.localeCompare(b.date));
    setSearchRes({q, orders, abuse, history});
  };

  const hasData = allOrderRows.length > 0;
  const hasResp = responseData.length > 0;

  const FilterBar = () => (
    <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
        {years.map(y=>(
          <button key={y} onClick={()=>setYearFilter(y)}
            style={{padding:"4px 12px",borderRadius:20,border:`1px solid ${yearFilter===y?"#1d4ed8":"#1e3a5f"}`,fontSize:11,fontWeight:600,cursor:"pointer",background:yearFilter===y?"#1d4ed8":"#0d1b2e",color:yearFilter===y?"#fff":"#4a6fa5"}}>
            {y}
          </button>
        ))}
      </div>
      <select value={segFilter} onChange={e=>setSegFilter(e.target.value)}
        style={{padding:"5px 10px",borderRadius:8,border:"1px solid #1e3a5f",background:"#0d1b2e",color:"#c8d8f0",fontSize:11}}>
        <option>전체</option>
        {Object.keys(SEG_COLORS).map(s=><option key={s}>{s}</option>)}
      </select>
    </div>
  );

  const SheetBox = () => (
    <div style={{background:"#0d1b2e",borderRadius:14,padding:16,marginBottom:16,border:"1px solid #1e3a5f"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#c8d8f0"}}>🔗 Google Sheets 실시간 연동</div>
          <div style={{fontSize:11,color:"#2d4a6e",marginTop:2}}>결제취소악용자 대응현황 시트 4개 자동 로드</div>
        </div>
        {lastFetch&&<span style={{fontSize:11,color:"#22c55e"}}>✅ {lastFetch} 갱신</span>}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
        <button onClick={fetchSheets} disabled={sheetLoading}
          style={{padding:"9px 20px",borderRadius:9,border:"none",background:sheetLoading?"#1e3a5f":"#1d4ed8",color:"#fff",cursor:sheetLoading?"wait":"pointer",fontWeight:700,fontSize:13}}>
          {sheetLoading?"⏳ 불러오는 중...":responseData.length?"🔄 새로고침":"📡 대응현황 불러오기"}
        </button>
        {GSHEET_TARGETS.map((t,i)=>(
          <span key={i} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"#060d18",color:"#2d4a6e"}}>{t.label}</span>
        ))}
      </div>
      {sheetErr&&<div style={{color:"#ef4444",fontSize:11,marginTop:8}}>{sheetErr}</div>}
      {sheetStatus.length>0&&(
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:8}}>
          {sheetStatus.map((s,i)=>(
            <span key={i} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:s.ok?"#14532d":"#450a0a",color:s.ok?"#22c55e":"#ef4444"}}>
              {s.ok?"✅":"❌"} {s.label} {s.ok?`(${s.count}건)`:"실패"}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div style={{fontFamily:"'Pretendard','Apple SD Gothic Neo',sans-serif",background:"#060d18",minHeight:"100vh",color:"#c8d8f0",padding:18}}>

      {/* 헤더 */}
      <div style={{marginBottom:16,display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
        <div>
          <h1 style={{fontSize:20,fontWeight:800,color:"#e8f4ff",margin:0,letterSpacing:"-0.03em"}}>🎮 결제취소 악용자 대응현황</h1>
          <p style={{color:"#2d4a6e",fontSize:11,margin:"4px 0 0"}}>Google Play · iOS · 한국 · 일본 · 2018~현재</p>
        </div>
        <div style={{display:"flex",gap:6,fontSize:11,flexWrap:"wrap"}}>
          <span style={{padding:"3px 10px",borderRadius:20,background:hasData?"#14532d":"#0d1b2e",color:hasData?"#22c55e":"#2d4a6e",border:"1px solid #1e3a5f"}}>
            📁 {hasData?`${fmt(allOrderRows.length)}건 로드됨`:"파일 미업로드"}
          </span>
          <span style={{padding:"3px 10px",borderRadius:20,background:hasResp?"#14532d":"#0d1b2e",color:hasResp?"#22c55e":"#2d4a6e",border:"1px solid #1e3a5f"}}>
            📊 {hasResp?`대응현황 ${fmt(responseData.length)}건`:"대응현황 미로드"}
          </span>
        </div>
      </div>

      {/* 파일 업로드 — 1개 또는 2개 */}
      <div style={{background:"#0d1b2e",borderRadius:14,padding:16,marginBottom:16,border:"1px solid #1e3a5f"}}>
        <div style={{fontSize:13,fontWeight:700,color:"#c8d8f0",marginBottom:10}}>📁 엑셀 파일 업로드</div>
        <div style={{fontSize:11,color:"#2d4a6e",marginBottom:12}}>
          파일 구조 자동 인식 — <span style={{color:"#3b82f6"}}>결제취소 악용 대상자 OrderID</span> 시트 + <span style={{color:"#22c55e"}}>결제취소 악용자 리스트</span> 시트
        </div>

        {/* 업로드된 파일 목록 */}
        {files.length > 0 && (
          <div style={{marginBottom:12,display:"flex",gap:8,flexWrap:"wrap"}}>
            {files.map((f,i)=>(
              <div key={i} style={{background:"#060d18",borderRadius:10,padding:"8px 14px",border:"1px solid #22c55e44",display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:11,color:"#22c55e"}}>✅ {f.name}</span>
                <span style={{fontSize:10,color:"#2d4a6e"}}>주문 {fmt(f.orderRows.length)}건 · 악용자 {fmt(f.abuseRows.length)}명</span>
                <button onClick={()=>setFiles(prev=>prev.filter((_,j)=>j!==i))}
                  style={{background:"transparent",border:"none",color:"#ef4444",cursor:"pointer",fontSize:11,padding:0}}>✕</button>
              </div>
            ))}
          </div>
        )}

        <div
          onClick={()=>{const i=document.createElement("input");i.type="file";i.accept=".xlsx,.xls";i.multiple=true;i.onchange=e=>[...e.target.files].forEach(handleFile);i.click();}}
          onDrop={e=>{e.preventDefault();[...e.dataTransfer.files].forEach(handleFile);}}
          onDragOver={e=>e.preventDefault()}
          style={{border:"2px dashed #1e3a5f",borderRadius:10,padding:"20px",textAlign:"center",cursor:"pointer"}}>
          <div style={{fontSize:24,marginBottom:6}}>📂</div>
          <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600}}>클릭 또는 드래그하여 업로드</div>
          <div style={{fontSize:11,color:"#1e3a5f",marginTop:4}}>Google AOS 파일, iOS 파일 각각 또는 한번에 업로드</div>
        </div>

        {uploadLog.length > 0 && (
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginTop:10}}>
            {uploadLog.map((l,i)=>(
              <span key={i} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"#14532d",color:"#22c55e"}}>
                ✅ {l.sheet} ({l.type}: {l.count}건)
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 탭 */}
      <div style={{display:"flex",gap:2,marginBottom:18,background:"#0a1628",borderRadius:12,padding:4,width:"fit-content",flexWrap:"wrap"}}>
        {TABS.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{padding:"7px 15px",border:"none",borderRadius:9,fontSize:12,fontWeight:700,cursor:"pointer",background:tab===t?"#1d4ed8":"transparent",color:tab===t?"#fff":"#2d4a6e"}}>
            {t}
          </button>
        ))}
      </div>

      {/* ━━━ 전체 현황 ━━━ */}
      {tab==="전체 현황" && (<>
        <FilterBar/>
        {!hasData ? (
          <div style={{background:"#0d1b2e",borderRadius:14,padding:40,textAlign:"center",color:"#2d4a6e",fontSize:13,border:"1px dashed #1e3a5f"}}>
            위에서 엑셀 파일을 업로드하면 현황이 표시됩니다.
          </div>
        ) : (<>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:16}}>
            <Card icon="📋" label="총 환불 주문" value={fmt(stats.totalOrders)} sub="건수 기준" color="#3b82f6"/>
            <Card icon="👥" label="유니크 유저" value={fmt(stats.uniqueUsers)} sub="OpenID 기준" color="#8b5cf6"/>
            <Card icon="🔄" label="회수 처리" value={fmt(stats.recovered)} sub={`${stats.totalAbuse?Math.round(stats.recovered/stats.totalAbuse*100):0}%`} color="#22d3ee"/>
            <Card icon="🚫" label="제재 처리" value={fmt(stats.sanctioned)} sub={`${stats.totalAbuse?Math.round(stats.sanctioned/stats.totalAbuse*100):0}%`} color="#ef4444"/>
            {hasResp && <>
              <Card icon="✅" label="복구 완료" value={fmt(stats.respRecovered)} sub={`${stats.totalResp?Math.round(stats.respRecovered/stats.totalResp*100):0}%`} color="#22c55e"/>
              <Card icon="⏳" label="처리중" value={fmt(stats.respProcessing)} sub={`${stats.totalResp?Math.round(stats.respProcessing/stats.totalResp*100):0}%`} color="#f59e0b"/>
            </>}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:12,marginBottom:12}}>
            <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
              <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>연도별 환불 추이</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={yearlyChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0a1220"/>
                  <XAxis dataKey="year" tick={{fill:"#2d4a6e",fontSize:10}}/>
                  <YAxis tick={{fill:"#2d4a6e",fontSize:10}}/>
                  <Tooltip {...TT}/>
                  <Legend wrapperStyle={{fontSize:11}}/>
                  <Bar dataKey="Google·한국" fill="#3b82f6" stackId="a" radius={[3,3,0,0]}/>
                  <Bar dataKey="Google·일본" fill="#06b6d4" stackId="a"/>
                  <Bar dataKey="iOS·한국" fill="#a855f7" stackId="a"/>
                  <Bar dataKey="iOS·일본" fill="#ec4899" stackId="a"/>
                  <Bar dataKey="기타" fill="#475569" stackId="a"/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
              <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>세그먼트별 분포</div>
              {Object.entries(stats.segStats).sort((a,b)=>b[1]-a[1]).map(([seg,cnt])=>(
                <div key={seg} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"7px 10px",background:"#060d18",borderRadius:8,marginBottom:6}}>
                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:SEG_COLORS[seg]||"#4a6fa5"}}/>
                    <span style={{fontSize:11,color:"#4a6fa5"}}>{seg.replace("_"," · ")}</span>
                  </div>
                  <span style={{fontSize:13,fontWeight:700,color:SEG_COLORS[seg]||"#4a6fa5"}}>{fmt(cnt)}건</span>
                </div>
              ))}
            </div>
          </div>

          {hasResp && (
            <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
              <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>대응현황 추이 (Google Sheets 기준)</div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={respTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0a1220"/>
                  <XAxis dataKey="month" tick={{fill:"#2d4a6e",fontSize:10}}/>
                  <YAxis tick={{fill:"#2d4a6e",fontSize:10}}/>
                  <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:11}}/>
                  <Bar dataKey="복구완료" fill="#22c55e" stackId="a"/>
                  <Bar dataKey="재제재" fill="#ef4444" stackId="a"/>
                  <Bar dataKey="처리중" fill="#f59e0b" stackId="a"/>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>)}
      </>)}

      {/* ━━━ 연도별 분석 ━━━ */}
      {tab==="연도별 분석" && (<>
        <FilterBar/>
        {!hasData ? <div style={{background:"#0d1b2e",borderRadius:14,padding:40,textAlign:"center",color:"#2d4a6e",fontSize:13}}>파일을 먼저 업로드해주세요.</div> : (<>
          <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f",marginBottom:12}}>
            <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>연도별 현황 테이블</div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                <thead><tr style={{borderBottom:"1px solid #1e3a5f"}}>
                  {["연도","Google·한국","Google·일본","iOS·한국","iOS·일본","기타","합계"].map(h=>(
                    <th key={h} style={{padding:"8px 10px",textAlign:"left",color:"#2d4a6e",fontWeight:600}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {yearlyChart.map((row,i)=>{
                    const keys = ["Google·한국","Google·일본","iOS·한국","iOS·일본","기타"];
                    const total = keys.reduce((s,k)=>s+(row[k]||0),0);
                    return (
                      <tr key={i} style={{borderBottom:"1px solid #0a1220",background:yearFilter===row.year?"#0a1220":"transparent"}}>
                        <td style={{padding:"8px 10px",fontWeight:700,color:"#e8f4ff"}}>{row.year}년</td>
                        {keys.map(k=>(
                          <td key={k} style={{padding:"8px 10px",color:SEG_COLORS[k.replace("·","_")]||"#4a6fa5"}}>{fmt(row[k]||0)}</td>
                        ))}
                        <td style={{padding:"8px 10px",fontWeight:700,color:"#c8d8f0"}}>{fmt(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
            <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>월별 추이 {yearFilter!=="전체"?`(${yearFilter}년)`:""}</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={monthlyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#0a1220"/>
                <XAxis dataKey="month" tick={{fill:"#2d4a6e",fontSize:10}}/>
                <YAxis tick={{fill:"#2d4a6e",fontSize:10}}/>
                <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:11}}/>
                <Line type="monotone" dataKey="Google" stroke="#3b82f6" strokeWidth={2} dot={false}/>
                <Line type="monotone" dataKey="iOS" stroke="#a855f7" strokeWidth={2} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>)}
      </>)}

      {/* ━━━ 세그먼트 ━━━ */}
      {tab==="세그먼트" && (<>
        <FilterBar/>
        {!hasData ? <div style={{background:"#0d1b2e",borderRadius:14,padding:40,textAlign:"center",color:"#2d4a6e",fontSize:13}}>파일을 먼저 업로드해주세요.</div> : (
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:12}}>
            {Object.entries(SEG_COLORS).map(([seg,color])=>{
              const [platform,country] = seg.split("_");
              const orders = filtered.filter(d=>d.segment===seg);
              const abuse = allAbuseRows.filter(a=>a.segment===seg);
              const recovered = abuse.filter(a=>a.action==="회수").length;
              const sanctioned = abuse.filter(a=>a.action==="제재").length;
              const uniqueUsers = new Set(orders.map(d=>d.openid).filter(Boolean)).size;
              return (
                <div key={seg} style={{background:"#0d1b2e",borderRadius:14,padding:18,border:`1px solid ${color}33`,borderTop:`3px solid ${color}`}}>
                  <div style={{fontSize:14,fontWeight:800,color,marginBottom:14}}>
                    {platform==="Google"?"🤖":"🍎"} {platform} · {country}
                  </div>
                  {[
                    ["환불 주문",fmt(orders.length)+"건","#c8d8f0"],
                    ["유니크 유저",fmt(uniqueUsers)+"명","#8b5cf6"],
                    ["회수 처리",fmt(recovered)+"명","#22d3ee"],
                    ["제재 처리",fmt(sanctioned)+"명","#ef4444"],
                  ].map(([l,v,c])=>(
                    <div key={l} style={{display:"flex",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid #0a1220"}}>
                      <span style={{fontSize:12,color:"#2d4a6e"}}>{l}</span>
                      <span style={{fontSize:13,fontWeight:700,color:c}}>{v}</span>
                    </div>
                  ))}
                  {abuse.length>0&&(
                    <div style={{marginTop:12}}>
                      {[["회수",recovered,"#22d3ee"],["제재",sanctioned,"#ef4444"]].map(([l,v,c])=>(
                        <div key={l} style={{marginBottom:6}}>
                          <div style={{display:"flex",justifyContent:"space-between",fontSize:10,marginBottom:2}}>
                            <span style={{color:"#2d4a6e"}}>{l}</span>
                            <span style={{color:c}}>{abuse.length?Math.round(v/abuse.length*100):0}%</span>
                          </div>
                          <div style={{background:"#0a1220",borderRadius:4,height:5}}>
                            <div style={{width:`${abuse.length?Math.round(v/abuse.length*100):0}%`,height:"100%",background:c,borderRadius:4}}/>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </>)}

      {/* ━━━ 대응 현황 ━━━ */}
      {tab==="대응 현황" && (<>
        <SheetBox/>
        <FilterBar/>
        {!hasResp ? (
          <div style={{background:"#0d1b2e",borderRadius:14,padding:40,textAlign:"center",color:"#2d4a6e",fontSize:13,border:"1px dashed #1e3a5f"}}>
            위 버튼으로 Google Sheets 데이터를 불러오세요.
          </div>
        ) : (<>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:14}}>
            <Card icon="📋" label="총 대응건수" value={fmt(filteredResp.length)} sub="행 기준" color="#3b82f6"/>
            <Card icon="✅" label="복구 완료" value={fmt(stats.respRecovered)} sub={`${stats.totalResp?Math.round(stats.respRecovered/stats.totalResp*100):0}%`} color="#22c55e"/>
            <Card icon="🚫" label="재제재" value={fmt(stats.respResanctioned)} sub={`${stats.totalResp?Math.round(stats.respResanctioned/stats.totalResp*100):0}%`} color="#ef4444"/>
            <Card icon="⏳" label="처리중" value={fmt(stats.respProcessing)} sub={`${stats.totalResp?Math.round(stats.respProcessing/stats.totalResp*100):0}%`} color="#f59e0b"/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:12}}>
            <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
              <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>월별 대응현황 추이</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={respTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0a1220"/>
                  <XAxis dataKey="month" tick={{fill:"#2d4a6e",fontSize:10}}/>
                  <YAxis tick={{fill:"#2d4a6e",fontSize:10}}/>
                  <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:11}}/>
                  <Bar dataKey="복구완료" fill="#22c55e" stackId="a"/>
                  <Bar dataKey="재제재" fill="#ef4444" stackId="a"/>
                  <Bar dataKey="처리중" fill="#f59e0b" stackId="a"/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
              <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>처리 결과 비율</div>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={[
                    {name:"복구완료",value:stats.respRecovered,color:"#22c55e"},
                    {name:"재제재",value:stats.respResanctioned,color:"#ef4444"},
                    {name:"처리중",value:stats.respProcessing,color:"#f59e0b"},
                  ].filter(d=>d.value>0)} cx="50%" cy="50%" innerRadius={45} outerRadius={65} dataKey="value" paddingAngle={3}>
                    {[{color:"#22c55e"},{color:"#ef4444"},{color:"#f59e0b"}].map((e,i)=><Cell key={i} fill={e.color}/>)}
                  </Pie>
                  <Tooltip {...TT}/>
                </PieChart>
              </ResponsiveContainer>
              {[["복구완료",stats.respRecovered,"#22c55e"],["재제재",stats.respResanctioned,"#ef4444"],["처리중",stats.respProcessing,"#f59e0b"]].map(([l,v,c])=>(
                <div key={l} style={{display:"flex",alignItems:"center",gap:8,fontSize:12,marginTop:6}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:c}}/>
                  <span style={{color:"#2d4a6e"}}>{l}</span>
                  <span style={{marginLeft:"auto",fontWeight:700,color:c}}>{fmt(v)}명</span>
                </div>
              ))}
            </div>
          </div>
        </>)}
      </>)}

      {/* ━━━ 유저 조회 ━━━ */}
      {tab==="유저 조회" && (
        <div>
          <div style={{background:"#0d1b2e",borderRadius:12,padding:12,marginBottom:14,borderLeft:"4px solid #1d4ed8"}}>
            <div style={{fontSize:12,color:"#3b82f6",fontWeight:700}}>🔍 유저 조회 — 상담원용</div>
            <div style={{fontSize:11,color:"#2d4a6e",marginTop:2}}>OpenID 검색 → 주문내역 + 악용자 정보 + 처리 히스토리 타임라인</div>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()}
              placeholder="OpenID 입력 후 Enter"
              style={{flex:1,padding:"10px 14px",borderRadius:10,border:"1px solid #1e3a5f",background:"#0d1b2e",color:"#c8d8f0",fontSize:13,outline:"none"}}/>
            <button onClick={doSearch}
              style={{padding:"10px 20px",borderRadius:10,border:"none",background:"#1d4ed8",color:"#fff",cursor:"pointer",fontWeight:700,fontSize:13}}>조회</button>
          </div>

          {searchRes && (
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              {/* 요약 */}
              <div style={{background:"#0d1b2e",borderRadius:14,padding:16,border:"1px solid #1e3a5f"}}>
                <div style={{fontSize:14,fontWeight:800,color:"#e8f4ff",marginBottom:12}}>👤 {searchRes.q}</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {[
                    ["환불 주문",searchRes.orders.length+"건","#3b82f6"],
                    ["악용 횟수",searchRes.abuse?searchRes.abuse.abuseCount+"회":"없음","#f59e0b"],
                    ["처리 방식",searchRes.abuse?searchRes.abuse.action:"없음",searchRes.abuse?.action==="회수"?"#22d3ee":"#ef4444"],
                    ["대응 이력",searchRes.history.length+"건","#8b5cf6"],
                    ["최종 상태",searchRes.history.length?searchRes.history[searchRes.history.length-1].status:"없음",
                      searchRes.history.length?STATUS_COLORS[searchRes.history[searchRes.history.length-1].status]:"#4a6fa5"],
                  ].map(([l,v,c])=>(
                    <div key={l} style={{background:"#060d18",borderRadius:10,padding:"8px 14px"}}>
                      <div style={{fontSize:10,color:"#2d4a6e"}}>{l}</div>
                      <div style={{fontSize:14,fontWeight:700,color:c,marginTop:2}}>{v}</div>
                    </div>
                  ))}
                </div>
                {searchRes.abuse && (
                  <div style={{marginTop:12,background:"#060d18",borderRadius:8,padding:10,fontSize:11,color:"#4a6fa5"}}>
                    누적 획득 UC: <span style={{color:"#3b82f6"}}>{fmt(searchRes.abuse.totalUC)}</span> · 현재 보유 UC: <span style={{color:"#22c55e"}}>{fmt(searchRes.abuse.currentUC)}</span> · P값: <span style={{color:searchRes.abuse.pValue>=0?"#22d3ee":"#ef4444"}}>{fmt(searchRes.abuse.pValue)}</span>
                  </div>
                )}
              </div>

              {/* 히스토리 타임라인 */}
              {searchRes.history.length>0&&(
                <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
                  <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:16}}>📋 처리 히스토리 ({searchRes.history.length}건 · 날짜순)</div>
                  {searchRes.history.map((h,i)=>{
                    const col=STATUS_COLORS[h.status]||"#4a6fa5";
                    const isLast=i===searchRes.history.length-1;
                    return (
                      <div key={i} style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                          <div style={{width:32,height:32,borderRadius:"50%",background:isLast?col:col+"33",border:`2px solid ${col}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0}}>
                            {h.status==="복구완료"?"✅":h.status==="재제재"?"🚫":"⏳"}
                          </div>
                          {!isLast&&<div style={{width:2,height:36,background:"#1e3a5f"}}/>}
                        </div>
                        <div style={{paddingBottom:isLast?0:12,flex:1,background:isLast?col+"11":"transparent",borderRadius:isLast?8:0,padding:isLast?"8px 12px":"0 0 12px 0",border:isLast?`1px solid ${col}33`:"none"}}>
                          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                            <span style={{fontSize:12,fontWeight:700,color:"#e8f4ff"}}>{h.date}</span>
                            <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,background:col+"22",color:col}}>{h.status}</span>
                            <span style={{fontSize:10,color:"#2d4a6e"}}>{h.platform} · {h.country}</span>
                            {isLast&&<span style={{fontSize:10,color:col,fontWeight:700}}>← 최신</span>}
                          </div>
                          {h.resultText&&<div style={{fontSize:11,color:"#4a6fa5"}}>처리내용: <span style={{color:col}}>{h.resultText}</span></div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 환불 주문 */}
              {searchRes.orders.length>0&&(
                <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
                  <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:12}}>💳 환불 주문 내역 ({searchRes.orders.length}건)</div>
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                      <thead><tr style={{borderBottom:"1px solid #1e3a5f"}}>
                        {["날짜","주문번호","플랫폼","국가","UC잔액"].map(h=><th key={h} style={{padding:"7px 10px",textAlign:"left",color:"#2d4a6e"}}>{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {searchRes.orders.map((o,i)=>(
                          <tr key={i} style={{borderBottom:"1px solid #0a1220",background:i%2===0?"#0a1220":"transparent"}}>
                            <td style={{padding:"7px 10px",color:"#4a6fa5"}}>{o.date}</td>
                            <td style={{padding:"7px 10px",color:"#c8d8f0",fontSize:10}}>{o.orderNo}</td>
                            <td style={{padding:"7px 10px"}}><span style={{padding:"2px 7px",borderRadius:4,fontSize:10,background:o.platform==="Google"?"#1e3a5f":"#2d1b5e",color:o.platform==="Google"?"#3b82f6":"#a855f7"}}>{o.platform}</span></td>
                            <td style={{padding:"7px 10px",color:"#4a6fa5"}}>{o.country}</td>
                            <td style={{padding:"7px 10px",color:"#22d3ee"}}>{fmt(o.ucBalance)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {searchRes.orders.length===0&&searchRes.history.length===0&&(
                <div style={{background:"#0d1b2e",borderRadius:14,padding:24,textAlign:"center",color:"#2d4a6e",fontSize:13}}>
                  <strong style={{color:"#c8d8f0"}}>{searchRes.q}</strong> — 데이터 없음
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ━━━ AI 분석 ━━━ */}
      {tab==="AI 분석"&&(
        <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 300px)",minHeight:400}}>
          <div style={{background:"#0d1b2e",borderRadius:12,padding:12,marginBottom:12,borderLeft:"4px solid #1d4ed8"}}>
            <div style={{fontSize:12,color:"#3b82f6",fontWeight:700}}>🤖 AI 데이터 분석</div>
            <div style={{fontSize:11,color:"#2d4a6e",marginTop:2}}>업로드된 데이터 기반으로 자유롭게 질문하세요</div>
          </div>
          <div style={{flex:1,background:"#0d1b2e",borderRadius:14,padding:16,border:"1px solid #1e3a5f",overflowY:"auto",marginBottom:12}}>
            {chatMessages.map((m,i)=>(
              <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:12}}>
                <div style={{maxWidth:"80%",padding:"10px 14px",borderRadius:12,background:m.role==="user"?"#1d4ed8":"#0a1628",color:m.role==="user"?"#fff":"#c8d8f0",fontSize:13,lineHeight:1.6,whiteSpace:"pre-wrap",border:m.role==="assistant"?"1px solid #1e3a5f":"none",borderBottomRightRadius:m.role==="user"?4:12,borderBottomLeftRadius:m.role==="assistant"?4:12}}>
                  {m.content}
                </div>
              </div>
            ))}
            {chatLoading&&<div style={{display:"flex",justifyContent:"flex-start",marginBottom:12}}><div style={{padding:"10px 14px",borderRadius:12,background:"#0a1628",border:"1px solid #1e3a5f",color:"#3b82f6",fontSize:13}}>⏳ 분석 중...</div></div>}
            <div ref={chatEndRef}/>
          </div>
          <div style={{display:"flex",gap:8}}>
            <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendChat()}
              placeholder="질문 입력 (예: 2025년 일본 iOS 건수 몇 건이에요?)"
              style={{flex:1,padding:"12px 16px",borderRadius:12,border:"1px solid #1e3a5f",background:"#0d1b2e",color:"#c8d8f0",fontSize:13,outline:"none"}}/>
            <button onClick={sendChat} disabled={chatLoading}
              style={{padding:"12px 20px",borderRadius:12,border:"none",background:chatLoading?"#1e3a5f":"#1d4ed8",color:"#fff",cursor:chatLoading?"wait":"pointer",fontWeight:700,fontSize:13}}>전송</button>
          </div>
          <div style={{display:"flex",gap:6,marginTop:8,flexWrap:"wrap"}}>
            {["전체 기간 총 건수 알려줘","2025년 한국 vs 일본 비교해줘","복구완료율 가장 높은 세그먼트는?","회수 vs 제재 비율 알려줘"].map(q=>(
              <button key={q} onClick={()=>setChatInput(q)}
                style={{padding:"5px 12px",borderRadius:20,border:"1px solid #1e3a5f",background:"#0a1220",color:"#4a6fa5",cursor:"pointer",fontSize:11}}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{marginTop:16,padding:"8px 14px",background:"#0d1b2e",borderRadius:10,fontSize:10,color:"#1e3a5f",borderLeft:"3px solid #1d4ed8"}}>
        💡 엑셀 업로드 → 시트 자동 인식 · Google Sheets → 대응현황 실시간 로드 · AI 분석 → 자유 질문
      </div>
    </div>
  );
}
