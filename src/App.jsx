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

// 시트 4개 정의
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
  const c = String(currency || "").trim().toUpperCase();
  return CURRENCY_COUNTRY[c] || "기타";
}

function getSegment(platform, country) {
  return `${platform}_${country}`;
}

// AI로 처리결과 분류
async function classifyStatus(text) {
  if (!text || !text.trim()) return "처리중";
  const t = text.trim();
  // 빠른 키워드 분류 (API 절약)
  if (/회수|해제|복구|완료|정상화|재충전|재결제/.test(t)) return "복구완료";
  if (/제재|정지|ban|밴|재제재|다시.*정지|하지.*않|안.*하|않음|미결제/.test(t)) return "재제재";
  if (!t || t === "-" || t === "없음") return "처리중";

  // 애매한 경우 Claude API 분류
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 50,
        system: `다음 텍스트를 분류해. 반드시 JSON만 반환: {"status":"복구완료"} 또는 {"status":"재제재"} 또는 {"status":"처리중"}
복구완료: 재결제/회수/해제/복구 완료된 경우
재제재: 재결제 안함/다시 정지/밴 유지된 경우  
처리중: 아직 처리 안됐거나 불명확한 경우`,
        messages: [{ role: "user", content: `분류할 텍스트: "${t}"` }]
      })
    });
    const data = await res.json();
    const raw = data.content?.[0]?.text || "{}";
    const parsed = JSON.parse(raw.replace(/```json|```/g,"").trim());
    return parsed.status || "처리중";
  } catch {
    return "처리중";
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CSV 파싱
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseCSV(text) {
  const rows = [];
  let cur = "", inQ = false;
  const chars = text.replace(/\r\n/g,"\n").replace(/\r/g,"\n");
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '"') { if (inQ && chars[i+1]==='"') { cur+='"'; i++; } else inQ=!inQ; }
    else if (ch==='\n' && !inQ) { rows.push(cur); cur=""; }
    else cur+=ch;
  }
  if (cur.trim()) rows.push(cur);
  return rows.map(row => {
    const fields = []; let field="", inq=false;
    for (let i=0;i<row.length;i++) {
      const c=row[i];
      if (c==='"') { if(inq&&row[i+1]==='"'){field+='"';i++;}else inq=!inq; }
      else if (c===','&&!inq) { fields.push(field.trim()); field=""; }
      else field+=c;
    }
    fields.push(field.trim());
    return fields;
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Google Sheets → 대응현황 파싱
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
async function parseGSheetResponse(text, country, platform) {
  const allRows = parseCSV(text);
  if (allRows.length < 3) return [];
  
  // 헤더 찾기 (OPENID가 있는 행)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(10, allRows.length); i++) {
    if (allRows[i].some(c => /openid|open.id|オープン/i.test(c))) { headerIdx = i; break; }
  }
  if (headerIdx < 0) headerIdx = 0;
  
  const headers = allRows[headerIdx];
  const findCol = (...names) => {
    for (const n of names) {
      const idx = headers.findIndex(h => new RegExp(n, "i").test(h || ""));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const ci = {
    openid: findCol("openid","open.id","オープン","キャラ"),
    date: findCol("期間","기간","date","날짜","抽出"),
    abuseCount: findCol("악용 횟수","悪用","回数","횟수"),
    totalUC: findCol("獲得","획득.*UC","누적"),
    currentUC: findCol("保有","보유.*UC","현재"),
    amount: findCol("金額","금액","amount"),
    result: findCol("KW.*結果","KW.*결과","チャージ.*有無","결과","처리","result"),
  };

  // 마지막 비어있지 않은 컬럼을 result로 fallback
  if (ci.result < 0) {
    for (let i = headers.length - 1; i >= 0; i--) {
      if (headers[i] && headers[i].trim()) { ci.result = i; break; }
    }
  }

  const get = (row, idx) => (idx >= 0 && idx < row.length) ? row[idx] : "";
  const results = [];

  // 처리결과 텍스트 수집 후 배치 분류
  const toClassify = [];
  const rawRows = [];

  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || row.every(c => !c || c.trim() === "")) continue;
    const openid = get(row, ci.openid).trim();
    if (!openid) continue;

    const resultText = get(row, ci.result).trim();
    toClassify.push(resultText);
    rawRows.push({ row, openid, resultText });
  }

  // 키워드 분류 (API 없이)
  for (const { row, openid, resultText } of rawRows) {
    let status = "처리중";
    if (resultText) {
      if (/회수|해제|복구|완료|정상화|재충전|再チャージ|回収|解除/.test(resultText)) status = "복구완료";
      else if (/제재|정지|ban|밴|再制裁|BAN|하지.*않|않음|미결제|なし/.test(resultText)) status = "재제재";
      else if (resultText && resultText !== "-") status = "복구완료"; // 뭔가 적혀있으면 완료로 간주
    }

    const dateRaw = get(row, ci.date);
    const date = parseDate(dateRaw) || String(dateRaw).slice(0,10) || "";

    results.push({
      openid, country, platform,
      date, year: date.slice(0,4), month: date.slice(0,7),
      abuseCount: parseNum(get(row, ci.abuseCount)),
      totalUC: parseNum(get(row, ci.totalUC)),
      currentUC: parseNum(get(row, ci.currentUC)),
      amount: Math.abs(parseNum(get(row, ci.amount))),
      resultText, status,
    });
  }

  return results;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 엑셀 파싱 (환불 원본)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseRefundExcel(wb, platform) {
  const orders = [];
  wb.SheetNames.forEach(sName => {
    const ws = wb.Sheets[sName];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });
    if (!rows.length) return;
    const cols = Object.keys(rows[0]).map(c => c.toLowerCase());
    const hasOrder = cols.some(c => c.includes("order number") || c.includes("주문번호"));
    if (!hasOrder) return;

    rows.forEach(r => {
      const orderNo = String(r["Order Number"] || r["주문번호"] || "").trim();
      if (!orderNo.startsWith("GPA") && !orderNo.includes("-")) return;
      const dateRaw = r["Order Charged Date"] || r["날짜"] || "";
      const date = parseDate(String(dateRaw)) || String(dateRaw).slice(0,10);
      if (!date) return;
      const currency = String(r["Currency of Sale"] || r["화폐"] || "KRW").trim().toUpperCase();
      const country = getCountry(currency);
      const amount = Math.abs(parseNum(r["Charged Amount"] || r["Item Price"] || 0));
      const product = String(r["Product Title"] || r["상품명"] || "").trim();
      const openid = String(r["OPENID"] || r["openid"] || "").trim();

      orders.push({
        orderNo, date, year: date.slice(0,4), month: date.slice(0,7),
        currency, country, platform, amount, product, openid,
        segment: getSegment(platform, country),
      });
    });
  });
  return orders;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UI 컴포넌트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const Card = ({ icon, label, value, sub, color = "#3b82f6" }) => (
  <div style={{ background: "linear-gradient(135deg,#0d1b2e,#0a1220)", borderRadius: 14, padding: "16px 18px", border: `1px solid ${color}33`, borderLeft: `4px solid ${color}`, position: "relative", overflow: "hidden" }}>
    <div style={{ position: "absolute", top: -10, right: -10, width: 70, height: 70, background: `radial-gradient(circle,${color}18,transparent 70%)`, borderRadius: "50%" }} />
    <div style={{ fontSize: 10, color: "#2d4a6e", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.06em" }}>{icon} {label}</div>
    <div style={{ fontSize: 24, fontWeight: 800, color, lineHeight: 1 }}>{value}</div>
    {sub && <div style={{ fontSize: 10, color: "#2d4a6e", marginTop: 5 }}>{sub}</div>}
  </div>
);

const SegBadge = ({ seg, value, unit = "건" }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px", background: "#0a1220", borderRadius: 8, marginBottom: 6 }}>
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <div style={{ width: 8, height: 8, borderRadius: "50%", background: SEG_COLORS[seg] || "#4a6fa5", flexShrink: 0 }} />
      <span style={{ fontSize: 12, color: "#4a6fa5" }}>{seg.replace("_", " · ")}</span>
    </div>
    <span style={{ fontSize: 13, fontWeight: 700, color: SEG_COLORS[seg] || "#4a6fa5" }}>{fmt(value)}{unit}</span>
  </div>
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 메인 앱
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [tab, setTab] = useState("전체 현황");
  const [yearFilter, setYearFilter] = useState("전체");
  const [segFilter, setSegFilter] = useState("전체");

  // 엑셀 데이터
  const [aosOrders, setAosOrders] = useState([]);
  const [iosOrders, setIosOrders] = useState([]);
  const [aosLoaded, setAosLoaded] = useState(false);
  const [iosLoaded, setIosLoaded] = useState(false);

  // Google Sheets 대응현황
  const [responseData, setResponseData] = useState([]);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetErr, setSheetErr] = useState("");
  const [sheetStatus, setSheetStatus] = useState([]);
  const [lastFetch, setLastFetch] = useState("");

  // AI 채팅
  const [chatMessages, setChatMessages] = useState([
    { role: "assistant", content: "안녕하세요! 결제취소 악용자 대응현황 데이터를 분석해드립니다.\n\n예시 질문:\n• 2026년 구글 한국 주문건수 몇 건이에요?\n• 일본 유저 중 제재된 사람 몇 명이에요?\n• 복구 완료율이 어떻게 돼요?" }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);

  // 유저 조회
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState(null);

  // ── 엑셀 업로드 ──
  const handleFile = useCallback(async (file, platform) => {
    if (!file) return;
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab);
      const orders = parseRefundExcel(wb, platform);
      if (platform === "Google") { setAosOrders(orders); setAosLoaded(true); }
      else { setIosOrders(orders); setIosLoaded(true); }
    } catch (e) { alert("파싱 오류: " + e.message); }
  }, []);

  // ── Google Sheets 불러오기 ──
  const fetchSheets = useCallback(async () => {
    setSheetLoading(true); setSheetErr(""); setSheetStatus([]);
    const all = [];
    const log = [];

    for (const cfg of GSHEET_TARGETS) {
      let csvText = null;
      const urls = [
        `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&gid=${cfg.gid}`,
        `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${cfg.gid}`,
      ];
      for (const url of urls) {
        try {
          const res = await fetch(url);
          if (res.ok) { const t = await res.text(); if (t && t.length > 20) { csvText = t; break; } }
        } catch {}
      }
      if (!csvText) {
        try {
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(urls[0])}`;
          const res = await fetch(proxyUrl);
          if (res.ok) { const t = await res.text(); if (t && t.length > 20) csvText = t; }
        } catch {}
      }

      if (csvText) {
        const rows = await parseGSheetResponse(csvText, cfg.country, cfg.platform);
        all.push(...rows);
        log.push({ label: cfg.label, count: rows.length, ok: true });
      } else {
        log.push({ label: cfg.label, count: 0, ok: false });
      }
    }

    setSheetStatus(log);
    if (all.length > 0) {
      setResponseData(all);
      setLastFetch(new Date().toLocaleTimeString());
    } else {
      setSheetErr("데이터를 불러오지 못했어요. 시트가 '웹에 게시'되어 있는지 확인해주세요.");
    }
    setSheetLoading(false);
  }, []);

  // ── 전체 주문 ──
  const allOrders = useMemo(() => [...aosOrders, ...iosOrders], [aosOrders, iosOrders]);

  // ── 연도 목록 ──
  const years = useMemo(() => {
    const ys = [...new Set(allOrders.map(d => d.year))].filter(Boolean).sort();
    return ["전체", ...ys];
  }, [allOrders]);

  // ── 세그먼트 목록 ──
  const segments = useMemo(() => {
    const segs = [...new Set(allOrders.map(d => d.segment))].filter(Boolean).sort();
    return ["전체", ...segs];
  }, [allOrders]);

  // ── 필터 적용 ──
  const filtered = useMemo(() => allOrders.filter(d => {
    if (yearFilter !== "전체" && d.year !== yearFilter) return false;
    if (segFilter !== "전체" && d.segment !== segFilter) return false;
    return true;
  }), [allOrders, yearFilter, segFilter]);

  const filteredResp = useMemo(() => responseData.filter(d => {
    if (yearFilter !== "전체" && d.year !== yearFilter) return false;
    if (segFilter !== "전체" && getSegment(d.platform, d.country) !== segFilter) return false;
    return true;
  }), [responseData, yearFilter, segFilter]);

  // ── 핵심 통계 ──
  const stats = useMemo(() => {
    const totalOrders = filtered.length;
    const uniqueUsers = new Set(filtered.map(d => d.openid).filter(Boolean)).size;
    const totalAmount = filtered.reduce((s, d) => s + d.amount, 0);

    // 대응현황 집계 (OpenID별 최신 상태)
    const oidMap = {};
    [...filteredResp].sort((a,b) => a.date.localeCompare(b.date)).forEach(d => {
      if (!oidMap[d.openid]) oidMap[d.openid] = { status: d.status, lastDate: d.date };
      if (d.date >= oidMap[d.openid].lastDate) { oidMap[d.openid].status = d.status; oidMap[d.openid].lastDate = d.date; }
    });
    const ids = Object.values(oidMap);
    const recovered = ids.filter(d => d.status === "복구완료").length;
    const resanctioned = ids.filter(d => d.status === "재제재").length;
    const processing = ids.filter(d => d.status === "처리중").length;
    const totalResp = ids.length;

    // 세그먼트별
    const segStats = {};
    filtered.forEach(d => {
      if (!segStats[d.segment]) segStats[d.segment] = 0;
      segStats[d.segment]++;
    });

    return { totalOrders, uniqueUsers, totalAmount, recovered, resanctioned, processing, totalResp, segStats };
  }, [filtered, filteredResp]);

  // ── 연도별 차트 ──
  const yearlyChart = useMemo(() => {
    const g = {};
    allOrders.forEach(d => {
      if (!g[d.year]) g[d.year] = { year: d.year, "Google·한국": 0, "Google·일본": 0, "iOS·한국": 0, "iOS·일본": 0, "기타": 0 };
      const k = `${d.platform}·${d.country}`;
      if (g[d.year][k] !== undefined) g[d.year][k]++;
      else g[d.year]["기타"]++;
    });
    return Object.values(g).sort((a,b) => a.year.localeCompare(b.year));
  }, [allOrders]);

  // ── 월별 차트 ──
  const monthlyChart = useMemo(() => {
    const src = yearFilter === "전체" ? allOrders : filtered;
    const g = {};
    src.forEach(d => {
      if (!g[d.month]) g[d.month] = { month: d.month, Google: 0, iOS: 0 };
      g[d.month][d.platform]++;
    });
    return Object.values(g).sort((a,b) => a.month.localeCompare(b.month));
  }, [allOrders, filtered, yearFilter]);

  // ── 대응현황 추이 ──
  const respTrend = useMemo(() => {
    const g = {};
    filteredResp.forEach(d => {
      const k = d.month || d.year;
      if (!k) return;
      if (!g[k]) g[k] = { month: k, 복구완료: 0, 재제재: 0, 처리중: 0 };
      g[k][d.status]++;
    });
    return Object.values(g).sort((a,b) => a.month.localeCompare(b.month));
  }, [filteredResp]);

  // ── AI 채팅 ──
  const sendChat = useCallback(async () => {
    const msg = chatInput.trim();
    if (!msg || chatLoading) return;
    setChatInput("");
    setChatMessages(prev => [...prev, { role: "user", content: msg }]);
    setChatLoading(true);

    // 데이터 요약 컨텍스트
    const ctx = {
      totalOrders: allOrders.length,
      byYear: Object.fromEntries(yearlyChart.map(d => [d.year, Object.entries(d).filter(([k]) => k !== "year").reduce((s,[,v])=>s+v,0)])),
      bySegment: Object.fromEntries(Object.entries(stats.segStats || {})),
      response: { total: responseData.length, recovered: stats.recovered, resanctioned: stats.resanctioned, processing: stats.processing },
      aosLoaded, iosLoaded,
    };

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          system: `당신은 PUBG Mobile 결제취소 악용자 대응 데이터 분석 어시스턴트입니다.
현재 대시보드 데이터:
${JSON.stringify(ctx, null, 2)}

세그먼트 설명:
- Google·한국: Google Play KRW 결제
- Google·일본: Google Play JPY 결제  
- iOS·한국: App Store KRW 결제
- iOS·일본: App Store JPY 결제

대응현황:
- 복구완료: 재결제 후 계정 해제 완료
- 재제재: 재결제 안해서 다시 정지
- 처리중: 아직 처리 안됨

한국어로 간결하게 답변해주세요. 데이터가 없으면 "파일을 먼저 업로드해주세요"라고 안내해주세요.`,
          messages: chatMessages.filter(m => m.role !== "assistant" || m !== chatMessages[0]).concat([{ role: "user", content: msg }])
        })
      });
      const data = await res.json();
      const reply = data.content?.[0]?.text || "응답을 받지 못했어요.";
      setChatMessages(prev => [...prev, { role: "assistant", content: reply }]);
    } catch (e) {
      setChatMessages(prev => [...prev, { role: "assistant", content: "오류가 발생했어요: " + e.message }]);
    }
    setChatLoading(false);
  }, [chatInput, chatLoading, chatMessages, allOrders, yearlyChart, stats, responseData, aosLoaded, iosLoaded]);

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [chatMessages]);

  // ── 유저 조회 ──
  const doSearch = () => {
    const q = searchQ.trim();
    if (!q) return;
    const orders = allOrders.filter(d => d.openid.includes(q) || d.orderNo.includes(q));
    const history = responseData.filter(d => d.openid.includes(q)).sort((a,b) => a.date.localeCompare(b.date));
    setSearchRes({ q, orders, history });
  };

  const hasData = allOrders.length > 0;
  const hasResp = responseData.length > 0;

  const FilterBar = () => (
    <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {years.map(y => (
          <button key={y} onClick={() => setYearFilter(y)}
            style={{ padding: "4px 12px", borderRadius: 20, border: `1px solid ${yearFilter===y?"#1d4ed8":"#1e3a5f"}`, fontSize: 11, fontWeight: 600, cursor: "pointer", background: yearFilter===y?"#1d4ed8":"#0d1b2e", color: yearFilter===y?"#fff":"#4a6fa5" }}>
            {y}
          </button>
        ))}
      </div>
      <select value={segFilter} onChange={e => setSegFilter(e.target.value)}
        style={{ padding: "5px 10px", borderRadius: 8, border: "1px solid #1e3a5f", background: "#0d1b2e", color: "#c8d8f0", fontSize: 11 }}>
        {["전체", ...Object.keys(SEG_COLORS)].map(s => <option key={s}>{s}</option>)}
      </select>
    </div>
  );

  const SheetBox = () => (
    <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 16, marginBottom: 16, border: "1px solid #1e3a5f" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#c8d8f0" }}>🔗 Google Sheets 실시간 연동</div>
          <div style={{ fontSize: 11, color: "#2d4a6e", marginTop: 2 }}>결제취소악용자 대응현황 시트 4개 자동 로드</div>
        </div>
        {lastFetch && <span style={{ fontSize: 11, color: "#22c55e" }}>✅ {lastFetch} 갱신</span>}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={fetchSheets} disabled={sheetLoading}
          style={{ padding: "9px 20px", borderRadius: 9, border: "none", background: sheetLoading ? "#1e3a5f" : "#1d4ed8", color: "#fff", cursor: sheetLoading ? "wait" : "pointer", fontWeight: 700, fontSize: 13 }}>
          {sheetLoading ? "⏳ 불러오는 중..." : responseData.length ? "🔄 새로고침" : "📡 데이터 불러오기"}
        </button>
        {GSHEET_TARGETS.map((t,i) => (
          <span key={i} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: "#060d18", color: "#2d4a6e" }}>{t.label}</span>
        ))}
      </div>
      {sheetErr && <div style={{ color: "#ef4444", fontSize: 11, marginTop: 8 }}>{sheetErr}</div>}
      {sheetStatus.length > 0 && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 8 }}>
          {sheetStatus.map((s,i) => (
            <span key={i} style={{ fontSize: 10, padding: "3px 8px", borderRadius: 4, background: s.ok ? "#14532d" : "#450a0a", color: s.ok ? "#22c55e" : "#ef4444" }}>
              {s.ok ? "✅" : "❌"} {s.label} {s.ok ? `(${s.count}건)` : "실패"}
            </span>
          ))}
        </div>
      )}
    </div>
  );

  return (
    <div style={{ fontFamily: "'Pretendard','Apple SD Gothic Neo',sans-serif", background: "#060d18", minHeight: "100vh", color: "#c8d8f0", padding: 18 }}>

      {/* 헤더 */}
      <div style={{ marginBottom: 18, display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 8 }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 800, color: "#e8f4ff", margin: 0, letterSpacing: "-0.03em" }}>🎮 결제취소 악용자 대응현황</h1>
          <p style={{ color: "#2d4a6e", fontSize: 11, margin: "4px 0 0" }}>Google Play · iOS · 한국 · 일본 · 2018~현재</p>
        </div>
        <div style={{ display: "flex", gap: 6, fontSize: 11, flexWrap: "wrap" }}>
          <span style={{ padding: "3px 10px", borderRadius: 20, background: aosLoaded ? "#14532d" : "#0d1b2e", color: aosLoaded ? "#22c55e" : "#2d4a6e", border: "1px solid #1e3a5f" }}>🤖 AOS {aosLoaded ? fmt(aosOrders.length)+"건" : "미업로드"}</span>
          <span style={{ padding: "3px 10px", borderRadius: 20, background: iosLoaded ? "#14532d" : "#0d1b2e", color: iosLoaded ? "#22c55e" : "#2d4a6e", border: "1px solid #1e3a5f" }}>🍎 iOS {iosLoaded ? fmt(iosOrders.length)+"건" : "미업로드"}</span>
          <span style={{ padding: "3px 10px", borderRadius: 20, background: hasResp ? "#14532d" : "#0d1b2e", color: hasResp ? "#22c55e" : "#2d4a6e", border: "1px solid #1e3a5f" }}>📊 대응 {hasResp ? fmt(responseData.length)+"건" : "미로드"}</span>
        </div>
      </div>

      {/* 파일 업로드 */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
        {[["Google AOS", "Google", "#3b82f6", "🤖", aosLoaded, aosOrders.length], ["iOS", "iOS", "#a855f7", "🍎", iosLoaded, iosOrders.length]].map(([label, platform, color, icon, loaded, count]) => (
          <div key={platform}
            onClick={() => { const i=document.createElement("input");i.type="file";i.accept=".xlsx,.xls";i.onchange=e=>handleFile(e.target.files[0],platform);i.click(); }}
            onDrop={e=>{e.preventDefault();handleFile(e.dataTransfer.files[0],platform);}}
            onDragOver={e=>e.preventDefault()}
            style={{ background: "#0d1b2e", borderRadius: 12, padding: "14px 16px", border: loaded ? `2px solid ${color}55` : "2px dashed #1e3a5f", cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 40, height: 40, borderRadius: 10, background: `${color}22`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, flexShrink: 0 }}>{loaded ? "✅" : icon}</div>
            <div>
              <div style={{ fontSize: 12, fontWeight: 700, color: loaded ? color : "#4a6fa5" }}>{label} 파일 업로드</div>
              <div style={{ fontSize: 11, color: "#2d4a6e", marginTop: 2 }}>{loaded ? `${fmt(count)}건 로드됨` : "클릭 또는 드래그"}</div>
            </div>
          </div>
        ))}
      </div>

      {/* 탭 */}
      <div style={{ display: "flex", gap: 2, marginBottom: 18, background: "#0a1628", borderRadius: 12, padding: 4, width: "fit-content", flexWrap: "wrap" }}>
        {TABS.map(t => (
          <button key={t} onClick={() => setTab(t)}
            style={{ padding: "7px 15px", border: "none", borderRadius: 9, fontSize: 12, fontWeight: 700, cursor: "pointer", background: tab===t?"#1d4ed8":"transparent", color: tab===t?"#fff":"#2d4a6e" }}>
            {t}
          </button>
        ))}
      </div>

      {/* ━━━ 전체 현황 ━━━ */}
      {tab === "전체 현황" && (<>
        <FilterBar />
        {!hasData ? (
          <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 40, textAlign: "center", color: "#2d4a6e", fontSize: 13, border: "1px dashed #1e3a5f" }}>파일을 업로드하면 현황이 표시됩니다.</div>
        ) : (<>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginBottom: 16 }}>
            <Card icon="📋" label="총 환불 주문" value={fmt(stats.totalOrders)} sub="건수 기준" color="#3b82f6" />
            <Card icon="👥" label="유니크 유저" value={fmt(stats.uniqueUsers)} sub="OpenID 기준" color="#8b5cf6" />
            <Card icon="✅" label="복구 완료" value={fmt(stats.recovered)} sub={`${stats.totalResp ? Math.round(stats.recovered/stats.totalResp*100) : 0}%`} color="#22c55e" />
            <Card icon="🚫" label="재제재" value={fmt(stats.resanctioned)} sub={`${stats.totalResp ? Math.round(stats.resanctioned/stats.totalResp*100) : 0}%`} color="#ef4444" />
            <Card icon="⏳" label="처리중" value={fmt(stats.processing)} sub={`${stats.totalResp ? Math.round(stats.processing/stats.totalResp*100) : 0}%`} color="#f59e0b" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12, marginBottom: 12 }}>
            <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 18, border: "1px solid #1e3a5f" }}>
              <div style={{ fontSize: 13, color: "#4a6fa5", fontWeight: 600, marginBottom: 14 }}>연도별 환불 추이</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={yearlyChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0a1220" />
                  <XAxis dataKey="year" tick={{ fill: "#2d4a6e", fontSize: 10 }} />
                  <YAxis tick={{ fill: "#2d4a6e", fontSize: 10 }} />
                  <Tooltip {...TT} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="Google·한국" fill="#3b82f6" radius={[3,3,0,0]} stackId="a" />
                  <Bar dataKey="Google·일본" fill="#06b6d4" radius={[3,3,0,0]} stackId="a" />
                  <Bar dataKey="iOS·한국" fill="#a855f7" radius={[3,3,0,0]} stackId="a" />
                  <Bar dataKey="iOS·일본" fill="#ec4899" radius={[0,0,0,0]} stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 18, border: "1px solid #1e3a5f" }}>
              <div style={{ fontSize: 13, color: "#4a6fa5", fontWeight: 600, marginBottom: 14 }}>세그먼트별 분포</div>
              {Object.entries(stats.segStats).sort((a,b)=>b[1]-a[1]).map(([seg, cnt]) => (
                <SegBadge key={seg} seg={seg} value={cnt} />
              ))}
            </div>
          </div>

          {hasResp && (
            <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 18, border: "1px solid #1e3a5f" }}>
              <div style={{ fontSize: 13, color: "#4a6fa5", fontWeight: 600, marginBottom: 14 }}>대응현황 추이</div>
              <ResponsiveContainer width="100%" height={180}>
                <BarChart data={respTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0a1220" />
                  <XAxis dataKey="month" tick={{ fill: "#2d4a6e", fontSize: 10 }} />
                  <YAxis tick={{ fill: "#2d4a6e", fontSize: 10 }} />
                  <Tooltip {...TT} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="복구완료" fill="#22c55e" stackId="a" />
                  <Bar dataKey="재제재" fill="#ef4444" stackId="a" />
                  <Bar dataKey="처리중" fill="#f59e0b" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>)}
      </>)}

      {/* ━━━ 연도별 분석 ━━━ */}
      {tab === "연도별 분석" && (<>
        <FilterBar />
        {!hasData ? <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 40, textAlign: "center", color: "#2d4a6e", fontSize: 13 }}>파일을 먼저 업로드해주세요.</div> : (<>
          <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 18, border: "1px solid #1e3a5f", marginBottom: 12 }}>
            <div style={{ fontSize: 13, color: "#4a6fa5", fontWeight: 600, marginBottom: 14 }}>연도별 현황 테이블</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr style={{ borderBottom: "1px solid #1e3a5f" }}>
                  {["연도","Google·한국","Google·일본","iOS·한국","iOS·일본","기타","합계"].map(h => (
                    <th key={h} style={{ padding: "8px 10px", textAlign: "left", color: "#2d4a6e", fontWeight: 600 }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {yearlyChart.map((row, i) => {
                    const total = ["Google·한국","Google·일본","iOS·한국","iOS·일본","기타"].reduce((s,k)=>s+(row[k]||0),0);
                    return (
                      <tr key={i} style={{ borderBottom: "1px solid #0a1220", background: yearFilter===row.year?"#0a1220":"transparent" }}>
                        <td style={{ padding: "8px 10px", fontWeight: 700, color: "#e8f4ff" }}>{row.year}년</td>
                        {["Google·한국","Google·일본","iOS·한국","iOS·일본","기타"].map(k => (
                          <td key={k} style={{ padding: "8px 10px", color: SEG_COLORS[k.replace("·","_")] || "#4a6fa5" }}>{fmt(row[k]||0)}</td>
                        ))}
                        <td style={{ padding: "8px 10px", fontWeight: 700, color: "#c8d8f0" }}>{fmt(total)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 18, border: "1px solid #1e3a5f" }}>
            <div style={{ fontSize: 13, color: "#4a6fa5", fontWeight: 600, marginBottom: 14 }}>월별 추이 {yearFilter !== "전체" ? `(${yearFilter}년)` : ""}</div>
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={monthlyChart}>
                <CartesianGrid strokeDasharray="3 3" stroke="#0a1220" />
                <XAxis dataKey="month" tick={{ fill: "#2d4a6e", fontSize: 10 }} />
                <YAxis tick={{ fill: "#2d4a6e", fontSize: 10 }} />
                <Tooltip {...TT} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line type="monotone" dataKey="Google" stroke="#3b82f6" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="iOS" stroke="#a855f7" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>)}
      </>)}

      {/* ━━━ 세그먼트 ━━━ */}
      {tab === "세그먼트" && (<>
        <FilterBar />
        {!hasData ? <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 40, textAlign: "center", color: "#2d4a6e", fontSize: 13 }}>파일을 먼저 업로드해주세요.</div> : (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 12 }}>
            {Object.entries(SEG_COLORS).map(([seg, color]) => {
              const [platform, country] = seg.split("_");
              const orders = filtered.filter(d => d.segment === seg);
              const resp = filteredResp.filter(d => d.platform === platform && d.country === country);
              const oidMap = {};
              [...resp].sort((a,b)=>a.date.localeCompare(b.date)).forEach(d=>{
                if(!oidMap[d.openid]) oidMap[d.openid]={status:d.status,lastDate:d.date};
                if(d.date>=oidMap[d.openid].lastDate){oidMap[d.openid].status=d.status;oidMap[d.openid].lastDate=d.date;}
              });
              const ids = Object.values(oidMap);
              const recovered = ids.filter(d=>d.status==="복구완료").length;
              const resanctioned = ids.filter(d=>d.status==="재제재").length;
              const processing = ids.filter(d=>d.status==="처리중").length;
              const uniqueUsers = new Set(orders.map(d=>d.openid).filter(Boolean)).size;

              return (
                <div key={seg} style={{ background: "#0d1b2e", borderRadius: 14, padding: 18, border: `1px solid ${color}33`, borderTop: `3px solid ${color}` }}>
                  <div style={{ fontSize: 14, fontWeight: 800, color, marginBottom: 14 }}>
                    {platform === "Google" ? "🤖" : "🍎"} {platform} · {country}
                  </div>
                  {[
                    ["환불 주문", fmt(orders.length)+"건", "#c8d8f0"],
                    ["유니크 유저", fmt(uniqueUsers)+"명", "#8b5cf6"],
                    ["복구 완료", fmt(recovered)+"명", "#22c55e"],
                    ["재제재", fmt(resanctioned)+"명", "#ef4444"],
                    ["처리중", fmt(processing)+"명", "#f59e0b"],
                  ].map(([l,v,c]) => (
                    <div key={l} style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #0a1220" }}>
                      <span style={{ fontSize:12, color:"#2d4a6e" }}>{l}</span>
                      <span style={{ fontSize:13, fontWeight:700, color:c }}>{v}</span>
                    </div>
                  ))}
                  {ids.length > 0 && (
                    <div style={{ marginTop: 12 }}>
                      {[["복구완료",recovered,"#22c55e"],["재제재",resanctioned,"#ef4444"],["처리중",processing,"#f59e0b"]].map(([l,v,c]) => (
                        <div key={l} style={{ marginBottom: 6 }}>
                          <div style={{ display:"flex", justifyContent:"space-between", fontSize:10, marginBottom:2 }}>
                            <span style={{ color:"#2d4a6e" }}>{l}</span>
                            <span style={{ color:c }}>{ids.length ? Math.round(v/ids.length*100) : 0}%</span>
                          </div>
                          <div style={{ background:"#0a1220", borderRadius:4, height:5 }}>
                            <div style={{ width:`${ids.length?Math.round(v/ids.length*100):0}%`, height:"100%", background:c, borderRadius:4 }}/>
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
      {tab === "대응 현황" && (<>
        <SheetBox />
        <FilterBar />
        {!hasResp ? (
          <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 40, textAlign: "center", color: "#2d4a6e", fontSize: 13, border: "1px dashed #1e3a5f" }}>위 버튼으로 Google Sheets 데이터를 불러오세요.</div>
        ) : (<>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 10, marginBottom: 14 }}>
            <Card icon="📋" label="총 대응건수" value={fmt(filteredResp.length)} sub="행 기준" color="#3b82f6" />
            <Card icon="✅" label="복구 완료" value={fmt(stats.recovered)} sub={`${stats.totalResp?Math.round(stats.recovered/stats.totalResp*100):0}%`} color="#22c55e" />
            <Card icon="🚫" label="재제재" value={fmt(stats.resanctioned)} sub={`${stats.totalResp?Math.round(stats.resanctioned/stats.totalResp*100):0}%`} color="#ef4444" />
            <Card icon="⏳" label="처리중" value={fmt(stats.processing)} sub={`${stats.totalResp?Math.round(stats.processing/stats.totalResp*100):0}%`} color="#f59e0b" />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr", gap: 12 }}>
            <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 18, border: "1px solid #1e3a5f" }}>
              <div style={{ fontSize: 13, color: "#4a6fa5", fontWeight: 600, marginBottom: 14 }}>월별 대응현황 추이</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={respTrend}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0a1220" />
                  <XAxis dataKey="month" tick={{ fill: "#2d4a6e", fontSize: 10 }} />
                  <YAxis tick={{ fill: "#2d4a6e", fontSize: 10 }} />
                  <Tooltip {...TT} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="복구완료" fill="#22c55e" stackId="a" />
                  <Bar dataKey="재제재" fill="#ef4444" stackId="a" />
                  <Bar dataKey="처리중" fill="#f59e0b" stackId="a" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: "#0d1b2e", borderRadius: 14, padding: 18, border: "1px solid #1e3a5f" }}>
              <div style={{ fontSize: 13, color: "#4a6fa5", fontWeight: 600, marginBottom: 14 }}>처리 결과 비율</div>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={[
                    {name:"복구완료",value:stats.recovered,color:"#22c55e"},
                    {name:"재제재",value:stats.resanctioned,color:"#ef4444"},
                    {name:"처리중",value:stats.processing,color:"#f59e0b"},
                  ].filter(d=>d.value>0)} cx="50%" cy="50%" innerRadius={45} outerRadius={65} dataKey="value" paddingAngle={3}>
                    {[{color:"#22c55e"},{color:"#ef4444"},{color:"#f59e0b"}].map((e,i)=><Cell key={i} fill={e.color}/>)}
                  </Pie>
                  <Tooltip {...TT}/>
                </PieChart>
              </ResponsiveContainer>
              {[["복구완료",stats.recovered,"#22c55e"],["재제재",stats.resanctioned,"#ef4444"],["처리중",stats.processing,"#f59e0b"]].map(([l,v,c])=>(
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
      {tab === "유저 조회" && (
        <div>
          <div style={{ background: "#0d1b2e", borderRadius: 12, padding: 12, marginBottom: 14, borderLeft: "4px solid #1d4ed8" }}>
            <div style={{ fontSize: 12, color: "#3b82f6", fontWeight: 700 }}>🔍 유저 조회 — 상담원용</div>
            <div style={{ fontSize: 11, color: "#2d4a6e", marginTop: 2 }}>OpenID 검색 → 환불 내역 + 처리 히스토리 타임라인</div>
          </div>
          <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
            <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()}
              placeholder="OpenID 입력 후 Enter"
              style={{ flex:1, padding:"10px 14px", borderRadius:10, border:"1px solid #1e3a5f", background:"#0d1b2e", color:"#c8d8f0", fontSize:13, outline:"none" }}/>
            <button onClick={doSearch}
              style={{ padding:"10px 20px", borderRadius:10, border:"none", background:"#1d4ed8", color:"#fff", cursor:"pointer", fontWeight:700, fontSize:13 }}>조회</button>
          </div>

          {searchRes && (
            <div style={{ display:"flex", flexDirection:"column", gap:12 }}>
              {/* 요약 카드 */}
              <div style={{ background:"#0d1b2e", borderRadius:14, padding:16, border:"1px solid #1e3a5f" }}>
                <div style={{ fontSize:14, fontWeight:800, color:"#e8f4ff", marginBottom:12 }}>👤 {searchRes.q}</div>
                <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
                  {[
                    ["환불 주문", searchRes.orders.length+"건", "#3b82f6"],
                    ["대응 이력", searchRes.history.length+"건", "#f59e0b"],
                    ["최종 상태", searchRes.history.length ? searchRes.history[searchRes.history.length-1].status : "없음",
                      searchRes.history.length ? STATUS_COLORS[searchRes.history[searchRes.history.length-1].status] : "#4a6fa5"],
                  ].map(([l,v,c])=>(
                    <div key={l} style={{ background:"#060d18", borderRadius:10, padding:"8px 14px" }}>
                      <div style={{ fontSize:10, color:"#2d4a6e" }}>{l}</div>
                      <div style={{ fontSize:14, fontWeight:700, color:c, marginTop:2 }}>{v}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* 처리 히스토리 타임라인 */}
              {searchRes.history.length > 0 && (
                <div style={{ background:"#0d1b2e", borderRadius:14, padding:18, border:"1px solid #1e3a5f" }}>
                  <div style={{ fontSize:13, color:"#4a6fa5", fontWeight:600, marginBottom:16 }}>📋 처리 히스토리</div>
                  {searchRes.history.map((h, i) => {
                    const col = STATUS_COLORS[h.status] || "#4a6fa5";
                    const isLast = i === searchRes.history.length - 1;
                    return (
                      <div key={i} style={{ display:"flex", gap:14, alignItems:"flex-start" }}>
                        <div style={{ display:"flex", flexDirection:"column", alignItems:"center" }}>
                          <div style={{ width:32, height:32, borderRadius:"50%", background: isLast?col:col+"33", border:`2px solid ${col}`, display:"flex", alignItems:"center", justifyContent:"center", fontSize:12, flexShrink:0 }}>
                            {h.status==="복구완료"?"✅":h.status==="재제재"?"🚫":"⏳"}
                          </div>
                          {!isLast && <div style={{ width:2, height:36, background:"#1e3a5f" }}/>}
                        </div>
                        <div style={{ paddingBottom: isLast?0:12, flex:1,
                          background: isLast?col+"11":"transparent", borderRadius: isLast?8:0,
                          padding: isLast?"8px 12px":"0 0 12px 0",
                          border: isLast?`1px solid ${col}33`:"none" }}>
                          <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:4 }}>
                            <span style={{ fontSize:12, fontWeight:700, color:"#e8f4ff" }}>{h.date}</span>
                            <span style={{ padding:"2px 8px", borderRadius:4, fontSize:10, background:col+"22", color:col }}>{h.status}</span>
                            <span style={{ fontSize:10, color:"#2d4a6e" }}>{h.platform} · {h.country}</span>
                            {isLast && <span style={{ fontSize:10, color:col, fontWeight:700 }}>← 최신</span>}
                          </div>
                          {h.resultText && <div style={{ fontSize:11, color:"#4a6fa5" }}>처리내용: <span style={{ color:col }}>{h.resultText}</span></div>}
                          {h.abuseCount > 0 && <div style={{ fontSize:11, color:"#4a6fa5" }}>악용횟수: {h.abuseCount}회 · UC: {fmt(h.totalUC)} → {fmt(h.currentUC)}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* 환불 주문 내역 */}
              {searchRes.orders.length > 0 && (
                <div style={{ background:"#0d1b2e", borderRadius:14, padding:18, border:"1px solid #1e3a5f" }}>
                  <div style={{ fontSize:13, color:"#4a6fa5", fontWeight:600, marginBottom:12 }}>💳 환불 주문 내역</div>
                  <div style={{ overflowX:"auto" }}>
                    <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12 }}>
                      <thead><tr style={{ borderBottom:"1px solid #1e3a5f" }}>
                        {["날짜","주문번호","상품명","금액","플랫폼","국가"].map(h=><th key={h} style={{ padding:"7px 10px", textAlign:"left", color:"#2d4a6e" }}>{h}</th>)}
                      </tr></thead>
                      <tbody>
                        {searchRes.orders.map((o,i)=>(
                          <tr key={i} style={{ borderBottom:"1px solid #0a1220", background:i%2===0?"#0a1220":"transparent" }}>
                            <td style={{ padding:"7px 10px", color:"#4a6fa5" }}>{o.date}</td>
                            <td style={{ padding:"7px 10px", color:"#c8d8f0", fontSize:10 }}>{o.orderNo}</td>
                            <td style={{ padding:"7px 10px", color:"#c8d8f0" }}>{o.product||"-"}</td>
                            <td style={{ padding:"7px 10px", color:"#ef4444" }}>₩{fmt(o.amount)}</td>
                            <td style={{ padding:"7px 10px" }}><span style={{ padding:"2px 7px", borderRadius:4, fontSize:10, background:o.platform==="Google"?"#1e3a5f":"#2d1b5e", color:o.platform==="Google"?"#3b82f6":"#a855f7" }}>{o.platform}</span></td>
                            <td style={{ padding:"7px 10px", color:"#4a6fa5" }}>{o.country}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
          {searchRes && searchRes.orders.length===0 && searchRes.history.length===0 && (
            <div style={{ background:"#0d1b2e", borderRadius:14, padding:24, textAlign:"center", color:"#2d4a6e", fontSize:13 }}>
              <strong style={{ color:"#c8d8f0" }}>{searchRes.q}</strong> — 데이터 없음
            </div>
          )}
        </div>
      )}

      {/* ━━━ AI 분석 ━━━ */}
      {tab === "AI 분석" && (
        <div style={{ display:"flex", flexDirection:"column", height:"calc(100vh - 280px)", minHeight:400 }}>
          <div style={{ background:"#0d1b2e", borderRadius:12, padding:12, marginBottom:12, borderLeft:"4px solid #1d4ed8" }}>
            <div style={{ fontSize:12, color:"#3b82f6", fontWeight:700 }}>🤖 AI 데이터 분석</div>
            <div style={{ fontSize:11, color:"#2d4a6e", marginTop:2 }}>업로드된 데이터 기반으로 자유롭게 질문하세요</div>
          </div>

          {/* 채팅창 */}
          <div style={{ flex:1, background:"#0d1b2e", borderRadius:14, padding:16, border:"1px solid #1e3a5f", overflowY:"auto", marginBottom:12 }}>
            {chatMessages.map((m, i) => (
              <div key={i} style={{ display:"flex", justifyContent:m.role==="user"?"flex-end":"flex-start", marginBottom:12 }}>
                <div style={{
                  maxWidth:"80%", padding:"10px 14px", borderRadius:12,
                  background: m.role==="user" ? "#1d4ed8" : "#0a1628",
                  color: m.role==="user" ? "#fff" : "#c8d8f0",
                  fontSize:13, lineHeight:1.6,
                  borderBottomRightRadius: m.role==="user" ? 4 : 12,
                  borderBottomLeftRadius: m.role==="assistant" ? 4 : 12,
                  whiteSpace:"pre-wrap",
                  border: m.role==="assistant" ? "1px solid #1e3a5f" : "none",
                }}>
                  {m.content}
                </div>
              </div>
            ))}
            {chatLoading && (
              <div style={{ display:"flex", justifyContent:"flex-start", marginBottom:12 }}>
                <div style={{ padding:"10px 14px", borderRadius:12, background:"#0a1628", border:"1px solid #1e3a5f", color:"#3b82f6", fontSize:13 }}>⏳ 분석 중...</div>
              </div>
            )}
            <div ref={chatEndRef}/>
          </div>

          {/* 입력창 */}
          <div style={{ display:"flex", gap:8 }}>
            <input value={chatInput} onChange={e=>setChatInput(e.target.value)}
              onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendChat()}
              placeholder="질문을 입력하세요 (예: 2025년 일본 iOS 건수 몇 건이에요?)"
              style={{ flex:1, padding:"12px 16px", borderRadius:12, border:"1px solid #1e3a5f", background:"#0d1b2e", color:"#c8d8f0", fontSize:13, outline:"none" }}/>
            <button onClick={sendChat} disabled={chatLoading}
              style={{ padding:"12px 20px", borderRadius:12, border:"none", background:chatLoading?"#1e3a5f":"#1d4ed8", color:"#fff", cursor:chatLoading?"wait":"pointer", fontWeight:700, fontSize:13 }}>
              전송
            </button>
          </div>

          {/* 빠른 질문 */}
          <div style={{ display:"flex", gap:6, marginTop:8, flexWrap:"wrap" }}>
            {["전체 기간 총 건수 알려줘","2025년 한국 vs 일본 비교해줘","복구완료율이 가장 높은 세그먼트는?","올해 월별 추이 분석해줘"].map(q=>(
              <button key={q} onClick={()=>{setChatInput(q);}}
                style={{ padding:"5px 12px", borderRadius:20, border:"1px solid #1e3a5f", background:"#0a1220", color:"#4a6fa5", cursor:"pointer", fontSize:11 }}>
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ marginTop:16, padding:"8px 14px", background:"#0d1b2e", borderRadius:10, fontSize:10, color:"#1e3a5f", borderLeft:"3px solid #1d4ed8" }}>
        💡 엑셀 2개 업로드 → 환불 현황 분석 · Google Sheets 불러오기 → 대응현황 분석 · AI 분석 탭 → 자유 질문
      </div>
    </div>
  );
}
