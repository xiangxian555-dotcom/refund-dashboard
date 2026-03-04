import { useState, useMemo, useCallback } from "react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell } from "recharts";
import * as XLSX from "xlsx";

const PC = { Google:"#4285F4", iOS:"#A855F7" };
const TC = { "회수처리":"#22d3ee", "제재처리":"#ef4444", "고객센터환불":"#6366f1" };
const CURRENCY_COUNTRY = { KR:"한국", JP:"일본", US:"미국", TW:"대만", TH:"태국" };
const fmt = n => (n||0).toLocaleString();
const fmtKRW = n => "₩"+(n||0).toLocaleString();
const TT = { contentStyle:{background:"#0f172a",border:"1px solid #334155",borderRadius:8,fontSize:11} };
const MAIN_TABS = ["환불 현황","처리 유형","대응 현황","퍼널 통계","분석 리포트","프로세스 안내","유저 조회"];
const PERIOD_TABS = [{id:"monthly",l:"월별"},{id:"weekly",l:"주별"},{id:"daily",l:"일별"},{id:"yearly",l:"연별"}];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Google Sheets 설정
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const ORIG_SHEET_ID = "1xySVvqx0DXiox8fkvMAr86WzP1hTdHzJuxf63iop6l8";
const PUB_ID = "2PACX-1vSMjDEGcigtv5CjFVyN1Oi_cUj0VW1pKHWNl_Z5O9_kcmXPfH7c6GYP5yJrOCCg2jXJRF22JP2mWUAV";

const SHEET_TARGETS = [
  { label:"한국 AOS", country:"한국", platform:"Google", gid:"0" },
  { label:"한국 iOS", country:"한국", platform:"iOS", gid:"123906372" },
  // { label:"일본 AOS", country:"일본", platform:"Google", gid:"여기에_GID" },
  // { label:"일본 iOS", country:"일본", platform:"iOS", gid:"여기에_GID" },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유틸리티 함수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseDate(val) {
  if(!val) return null;
  const s = String(val).trim();
  const m2 = s.match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if(m2) return `${m2[1]}-${String(m2[2]).padStart(2,"0")}-${String(m2[3]).padStart(2,"0")}`;
  const m1 = s.match(/([A-Za-z]+)\s+(\d+),\s+(\d{4})/);
  if(m1) {
    const mo = {Jan:1,Feb:2,Mar:3,Apr:4,May:5,Jun:6,Jul:7,Aug:8,Sep:9,Oct:10,Nov:11,Dec:12}[m1[1]];
    if(mo) return `${m1[3]}-${String(mo).padStart(2,"0")}-${String(m1[2]).padStart(2,"0")}`;
  }
  return null;
}
function parseAmount(v) { 
  const s = String(v||"").replace(/[₩원\s]/g,"").trim();
  if (!s) return 0;
  // 숫자와 쉼표, 마침표만 추출
  const m = s.match(/([\d,]+\.?\d*)/);
  if (!m) return 0;
  return parseFloat(m[1].replace(/,/g,"")) || 0;
}
function parseUC(t) { const m=String(t||"").match(/(\d[\d,]*)/); return m?parseInt(m[1].replace(/,/g,"")):0; }

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// CSV 파싱 — 따옴표+줄바꿈 완벽 처리
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseCSVRobust(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;
  const chars = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '"') {
      if (inQuotes && chars[i+1] === '"') {
        current += '"'; i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === '\n' && !inQuotes) {
      rows.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) rows.push(current);

  // 각 행을 필드로 분리
  return rows.map(row => {
    const fields = [];
    let field = "";
    let inQ = false;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c === '"') {
        if (inQ && row[i+1] === '"') { field += '"'; i++; }
        else { inQ = !inQ; }
      } else if (c === ',' && !inQ) {
        fields.push(field.trim());
        field = "";
      } else {
        field += c;
      }
    }
    fields.push(field.trim());
    return fields;
  });
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 대응현황 CSV → 구조화 데이터 변환
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseResponseCSV(text, country, platform, colMap) {
  const allRows = parseCSVRobust(text);
  if (allRows.length < 2) return [];
  const headers = allRows[0];

  // 컬럼 인덱스 매핑 — 헤더명으로 자동 탐지 (AI 결과는 fallback)
  const findCol = (names) => {
    for (const name of names) {
      const idx = headers.findIndex(h => h && h.trim().toLowerCase().includes(name.toLowerCase()));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  // 항상 자동 탐지 우선, 못 찾으면 AI 결과 사용
  const autoOrAI = (names, aiKey) => {
    const auto = findCol(names);
    if (auto >= 0) return auto;
    if (colMap?.[aiKey] != null) {
      const aiIdx = headers.indexOf(colMap[aiKey]);
      if (aiIdx >= 0) return aiIdx;
    }
    return -1;
  };

  const ci = {
    date:           autoOrAI(["Date", "date", "날짜", "등록일"], "date"),
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

  console.log("📊 컬럼 매핑:", headers.map((h,i)=>`${i}:${h}`).join(" | "));
  console.log("📊 매핑 결과:", JSON.stringify(ci));

  const get = (row, idx) => (idx >= 0 && idx < row.length) ? row[idx] : "";

  const results = [];
  let lastDate = null; // 이전 행의 날짜를 기억

  for (let i = 1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row || row.length < 3) continue;
    // 완전히 빈 행 스킵
    if (row.every(c => !c || c.trim() === "")) continue;

    const dateRaw = get(row, ci.date);
    const openid = get(row, ci.openid);
    const processDateRaw = get(row, ci.processDate).trim();
    const resultText = get(row, ci.processResult).trim();

    // N열(처리날짜)과 O열(처리결과) 합쳐서 분석 — 초기 데이터는 N열에 결과가 같이 있음
    const combinedText = (processDateRaw + " " + resultText).trim();

    // 날짜 파싱 — 없으면 이전 행의 날짜 사용
    let dateParsed = parseDate(dateRaw);
    if (dateParsed) {
      lastDate = dateParsed;
    } else {
      dateParsed = lastDate;
    }

    // openid가 없으면 스킵
    if (!openid || openid.trim() === "") continue;
    // 날짜가 여전히 없으면 스킵
    if (!dateParsed) continue;

    const [year, month, day] = dateParsed.split("-").map(Number);

    // 처리날짜에서 실제 날짜만 추출
    const processDateParsed = parseDate(processDateRaw);

    // 처리결과 판단 — N열+O열 합쳐서 키워드 탐색
    let status = "처리중";
    let resanctioned = false;
    let displayResult = resultText || "";

    // O열이 비어있으면 N열에서 결과 텍스트 추출 시도
    if (!resultText && processDateRaw) {
      // N열에서 날짜 부분 제거 후 남은 텍스트를 결과로 사용
      const withoutDate = processDateRaw.replace(/\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/g, "").trim();
      if (withoutDate) displayResult = withoutDate;
    }

    if (combinedText === "") {
      status = "처리중";
    } else if (combinedText.includes("제재") || combinedText.includes("제제") ||
               combinedText.includes("정지") || combinedText.includes("밴") ||
               combinedText.includes("하지 않아") || combinedText.includes("하지않아") ||
               combinedText.includes("않음") || combinedText.includes("안하") || 
               combinedText.includes("안 하") || combinedText.includes("부족") ||
               combinedText.includes("재재정") || combinedText.includes("사용했습니다")) {
      // 재제재 키워드 (회수/해제보다 우선)
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

  return results;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// UI 컴포넌트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const Card = ({icon,label,value,sub,color="#6366f1"}) => (
  <div style={{background:"#1e293b",borderRadius:12,padding:"14px 16px",borderTop:`3px solid ${color}`}}>
    <div style={{fontSize:11,color:"#64748b",marginBottom:4}}>{icon} {label}</div>
    <div style={{fontSize:20,fontWeight:700,color}}>{value}</div>
    {sub && <div style={{fontSize:10,color:"#64748b",marginTop:2}}>{sub}</div>}
  </div>
);

function DateFilter({from,to,onFrom,onTo,onReset}) {
  return (
    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
      <span style={{fontSize:12,color:"#64748b"}}>📅</span>
      <input type="date" value={from} onChange={e=>onFrom(e.target.value)}
        style={{padding:"6px 10px",borderRadius:8,border:"1px solid #334155",background:"#1e293b",color:"#e2e8f0",fontSize:12}}/>
      <span style={{color:"#64748b"}}>~</span>
      <input type="date" value={to} onChange={e=>onTo(e.target.value)}
        style={{padding:"6px 10px",borderRadius:8,border:"1px solid #334155",background:"#1e293b",color:"#e2e8f0",fontSize:12}}/>
      <button onClick={onReset} style={{padding:"6px 10px",borderRadius:8,border:"1px solid #334155",background:"transparent",color:"#94a3b8",cursor:"pointer",fontSize:12}}>초기화</button>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 메인 앱
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [tab, setTab] = useState("환불 현황");
  const [period, setPeriod] = useState("monthly");
  const [respPeriod, setRespPeriod] = useState("monthly");
  const [country, setCountry] = useState("전체");
  const [platform, setPlatform] = useState("전체");
  const [from, setFrom] = useState("2018-01-01");
  const [to, setTo] = useState("2026-12-31");

  // 엑셀 데이터
  const [refundData, setRefundData] = useState([]);
  const [processData, setProcessData] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [uploadErr, setUploadErr] = useState("");
  const [sheetLog, setSheetLog] = useState([]);
  const [fileName, setFileName] = useState("");

  // 대응현황 데이터
  const [responseData, setResponseData] = useState([]);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetErr, setSheetErr] = useState("");
  const [lastFetch, setLastFetch] = useState(null);
  const [sheetStatus, setSheetStatus] = useState([]);

  // AI 분석
  const [aiStatus, setAiStatus] = useState("");
  const [colMap, setColMap] = useState(null);

  // ── 엑셀 파싱 ──────────────────────────────
  const parseFile = useCallback(async (file) => {
    setUploading(true); setUploadErr(""); setSheetLog([]);
    setFileName(file.name);
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab);
      const refRows = [], procRows = [], log = [];

      wb.SheetNames.forEach(sName => {
        const ws = wb.Sheets[sName];
        const rows = XLSX.utils.sheet_to_json(ws, {defval:""});
        if(!rows.length) { log.push(`"${sName}" → 빈 시트`); return; }
        const cols = Object.keys(rows[0]).map(c=>c.trim());
        const isRefund = cols.some(c=>/order.*(number|charged|date)/i.test(c)||/financial.status/i.test(c));
        const isProcess = cols.some(c=>/openid/i.test(c)) && (cols.some(c=>/누적.*획득/i.test(c))||cols.some(c=>/현재.*보유/i.test(c)));

        if(isRefund) {
          log.push(`✅ "${sName}" → 환불 원본 (${rows.length}행)`);
          let plt = sName.toLowerCase().includes("ios")?"iOS":"Google";
          rows.forEach(r => {
            const orderNo = String(r["Order Number"]||r["주문번호"]||"");
            if(orderNo.startsWith("GPA")) plt="Google";
            const dateStr = parseDate(r["Order Charged Date"]||r["Date"]||r["날짜"]||"");
            if(!dateStr) return;
            const [y,m,d] = dateStr.split("-").map(Number);
            const ctryRaw = String(r["Country of Buyer"]||"KR").trim().toUpperCase();
            const product = String(r["Product Title"]||r["상품명"]||"");
            refRows.push({
              orderNo, date:dateStr, year:y, month:m, day:d, week:Math.ceil(d/7),
              platform:plt, country:CURRENCY_COUNTRY[ctryRaw]||ctryRaw,
              product, amount:parseAmount(r["Charged Amount"]||r["Item Price"]||0),
              uc:parseUC(product),
              financialStatus:String(r["Financial Status"]||"").toLowerCase(),
              openid:String(r["OPENID"]||r["openid"]||""),
            });
          });
        } else if(isProcess) {
          log.push(`✅ "${sName}" → 처리 결과 (${rows.length}행)`);
          const plt = sName.toLowerCase().includes("ios")?"iOS":"Google";
          const ctry = sName.includes("일본")||sName.includes("JP")?"일본":"한국";
          rows.forEach(r => {
            const openid = String(r["OPENID"]||r["openid"]||"").trim();
            if(!openid) return;
            const cur = String(r["화폐"]||"").trim().toUpperCase();
            const totalUC = parseFloat(r["누적 획득 UC"]||0)||0;
            const currentUC = parseFloat(r["현재 보유 UC"]||0)||0;
            const pVal = parseFloat(r["P값"]||(totalUC-currentUC))||(totalUC-currentUC);
            const resultRaw = String(r["처리결과"]||"");
            let type = pVal<0?"제재처리":"회수처리";
            if(resultRaw.includes("고객")||resultRaw.includes("CS")) type="고객센터환불";
            procRows.push({
              openid, country:CURRENCY_COUNTRY[cur]||ctry, platform:plt,
              abuseCount:parseInt(r["악용 횟수"]||0)||0,
              totalUC, currentUC, pValue:pVal, type, result:resultRaw,
            });
          });
        } else {
          log.push(`⚠️ "${sName}" → 컬럼 인식 불가 (스킵)`);
        }
      });

      setSheetLog(log);
      setRefundData(refRows);
      setProcessData(procRows);
      if(!refRows.length && !procRows.length) setUploadErr("데이터를 인식하지 못했어요. 컬럼명을 확인해주세요.");
    } catch(e) { setUploadErr("파싱 오류: "+e.message); }
    setUploading(false);
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files?.[0];
    if(f) parseFile(f);
  }, [parseFile]);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Google Sheets 실시간 연동 + AI 분석
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const fetchSheet = useCallback(async () => {
    setSheetLoading(true); setSheetErr(""); setSheetStatus([]);
    const allRows = [];
    const statusLog = [];

    for (const cfg of SHEET_TARGETS) {
      let csvText = null;
      console.log(`📡 [${cfg.label}] 데이터 로딩 시작... gid=${cfg.gid}`);

      // 1차: Visualization API
      try {
        const vizUrl = `https://docs.google.com/spreadsheets/d/${ORIG_SHEET_ID}/gviz/tq?tqx=out:csv&gid=${cfg.gid}`;
        const res = await fetch(vizUrl);
        console.log(`📡 [${cfg.label}] Viz API 응답:`, res.status, res.ok);
        if (res.ok) {
          const text = await res.text();
          console.log(`📡 [${cfg.label}] Viz API 텍스트 길이:`, text.length);
          if (text && text.length > 10) csvText = { text, method:"Viz API" };
        }
      } catch(e) { console.warn(`[${cfg.label}] Viz API 실패:`, e.message); }

      // 2차: pub CSV
      if (!csvText) {
        try {
          const pubUrl = `https://docs.google.com/spreadsheets/d/e/${PUB_ID}/pub?gid=${cfg.gid}&single=true&output=csv`;
          const res = await fetch(pubUrl);
          if (res.ok) {
            const text = await res.text();
            if (text && text.length > 10) csvText = { text, method:"직접 연결" };
          }
        } catch(e) {}
      }

      // 3차: CORS 프록시
      if (!csvText) {
        try {
          const pubUrl = `https://docs.google.com/spreadsheets/d/e/${PUB_ID}/pub?gid=${cfg.gid}&single=true&output=csv`;
          const proxyUrl = `https://api.allorigins.win/raw?url=${encodeURIComponent(pubUrl)}`;
          const res = await fetch(proxyUrl);
          if (res.ok) {
            const text = await res.text();
            if (text && text.length > 10) csvText = { text, method:"CORS 프록시" };
          }
        } catch(e) {}
      }

      if (csvText) {
        // AI 분석 시도
        let currentColMap = colMap;
        if (!currentColMap) {
          setAiStatus("🤖 AI가 컬럼 구조를 분석 중...");
          try {
            const csvLines = csvText.text.split("\n");
            const sample = csvLines.slice(0, 6).join("\n");
            const aiRes = await fetch("/api/analyze", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ csvSample: sample, totalRows: csvLines.length })
            });
            if (aiRes.ok) {
              const aiData = await aiRes.json();
              if (aiData.columns) {
                currentColMap = aiData.columns;
                setColMap(currentColMap);
                setAiStatus(`✅ AI 분석 완료`);
              }
            }
          } catch(e) {
            console.warn("AI 분석 실패, 기본 매핑 사용:", e.message);
            setAiStatus("⚠️ AI 분석 실패 — 기본 매핑 사용");
          }
        }

        const rows = parseResponseCSV(csvText.text, cfg.country, cfg.platform, currentColMap);
        console.log(`✅ [${cfg.label}] 파싱 결과: ${rows.length}건`);
        allRows.push(...rows);
        statusLog.push({ label:cfg.label, count:rows.length, ok:true, method:csvText.method });
      } else {
        statusLog.push({ label:cfg.label, count:0, ok:false, err:"연결 실패" });
      }
    }

    setSheetStatus(statusLog);
    if (allRows.length === 0) {
      setSheetErr("데이터를 불러오지 못했어요. 시트의 '웹에 게시' 설정을 확인해주세요.");
    } else {
      setResponseData(allRows);
      setLastFetch(new Date().toLocaleTimeString());
    }
    setSheetLoading(false);
  }, [colMap]);

  // ── 데이터 계산 ─────────────────────────────
  const merged = useMemo(() => {
    const pMap = {};
    processData.forEach(p => { pMap[p.openid] = p; });
    return refundData.map(r => {
      const p = pMap[r.openid]||{};
      return { ...r, type:p.type||"회수처리",
        abuseCount:p.abuseCount||0, totalUC:p.totalUC||r.uc,
        currentUC:p.currentUC||0, pValue:p.pValue??0, result:p.result||"" };
    });
  }, [refundData, processData]);

  const filtered = useMemo(() => merged.filter(d => {
    if(d.date<from||d.date>to) return false;
    if(country!=="전체"&&d.country!==country) return false;
    if(platform!=="전체"&&d.platform!==platform) return false;
    return true;
  }), [merged, from, to, country, platform]);

  // 대응현황 필터 (날짜 기반)
  const respFiltered = useMemo(() => responseData.filter(d => {
    if(d.date<from||d.date>to) return false;
    if(country!=="전체"&&d.country!==country) return false;
    if(platform!=="전체"&&d.platform!==platform) return false;
    return true;
  }), [responseData, from, to, country, platform]);

  // openid 기준 유니크 카운트
  const uniqueOpenids = useMemo(() => {
    const map = {};
    respFiltered.forEach(d => {
      if (!map[d.openid]) map[d.openid] = { status: d.status, resanctioned: d.resanctioned, amount: 0 };
      map[d.openid].amount += d.rechargeAmount;
      // 최신 상태로 업데이트 (복구완료 > 재제재 > 처리중)
      if (d.status === "복구완료") map[d.openid].status = "복구완료";
      if (d.status === "재제재") { map[d.openid].status = "재제재"; map[d.openid].resanctioned = true; }
    });
    return map;
  }, [respFiltered]);

  const respSummary = useMemo(() => {
    const ids = Object.values(uniqueOpenids);
    return {
      totalRows: respFiltered.length,
      uniqueUsers: ids.length,
      recovered: ids.filter(d => d.status === "복구완료").length,
      processing: ids.filter(d => d.status === "처리중").length,
      resanctioned: ids.filter(d => d.status === "재제재").length,
      totalAmount: ids.reduce((s, d) => s + d.amount, 0),
    };
  }, [uniqueOpenids, respFiltered]);

  // 대응현황 날짜 기반 추이
  const respPKey = d => {
    if(respPeriod==="daily") return `${d.month}월${d.day}일`;
    if(respPeriod==="weekly") return `${d.year}-${String(d.month).padStart(2,"0")} ${d.week}주`;
    if(respPeriod==="monthly") return `${d.year}-${String(d.month).padStart(2,"0")}`;
    return `${d.year}년`;
  };

  const respTrendData = useMemo(() => {
    const g = {};
    respFiltered.forEach(d => {
      const k = respPKey(d);
      if(!g[k]) g[k] = { name:k, 복구완료:0, 처리중:0, 재제재:0, total:0, _s:d.date };
      g[k][d.status]++;
      g[k].total++;
    });
    return Object.values(g).sort((a,b) => a._s.localeCompare(b._s));
  }, [respFiltered, respPeriod]);

  // 환불 현황 관련
  const pKey = d => {
    if(period==="daily") return d.month+"월"+d.day+"일";
    if(period==="weekly") return d.month+"월"+d.week+"주";
    if(period==="monthly") return d.year+"-"+String(d.month).padStart(2,"0");
    return d.year+"년";
  };

  const trendData = useMemo(() => {
    const g={};
    filtered.forEach(d => {
      const k=pKey(d);
      if(!g[k]) g[k]={name:k,Google:0,iOS:0,totalAmt:0,_s:d.date};
      g[k][d.platform]++; g[k].totalAmt+=d.amount;
    });
    return Object.values(g).sort((a,b)=>a._s.localeCompare(b._s));
  }, [filtered, period]);

  const typeData = useMemo(() => {
    const g={};
    filtered.forEach(d => {
      const k=pKey(d);
      if(!g[k]) g[k]={name:k,"회수처리":0,"제재처리":0,"고객센터환불":0,_s:d.date};
      g[k][d.type]++;
    });
    return Object.values(g).sort((a,b)=>a._s.localeCompare(b._s));
  }, [filtered, period]);

  const summary = useMemo(() => ({
    total:filtered.length, google:filtered.filter(d=>d.platform==="Google").length,
    ios:filtered.filter(d=>d.platform==="iOS").length,
    recover:filtered.filter(d=>d.type==="회수처리").length,
    sanction:filtered.filter(d=>d.type==="제재처리").length,
    totalAmt:filtered.reduce((s,d)=>s+d.amount,0),
  }), [filtered]);

  const piePlatform = useMemo(()=>{
    const c={};filtered.forEach(d=>{c[d.platform]=(c[d.platform]||0)+1;});
    return Object.entries(c).map(([k,v])=>({name:k,value:v,color:PC[k]}));
  },[filtered]);

  const pieType = useMemo(()=>{
    const c={};filtered.forEach(d=>{c[d.type]=(c[d.type]||0)+1;});
    return Object.entries(c).map(([k,v])=>({name:k,value:v,color:TC[k]}));
  },[filtered]);

  const pieResp = useMemo(()=>[
    {name:"복구완료", value:respSummary.recovered, color:"#22c55e"},
    {name:"처리중", value:respSummary.processing, color:"#22d3ee"},
    {name:"재제재", value:respSummary.resanctioned, color:"#ef4444"},
  ].filter(d=>d.value>0),[respSummary]);

  const countries = useMemo(()=>{
    const all = [...merged.map(d=>d.country), ...responseData.map(d=>d.country)].filter(Boolean);
    return ["전체", ...new Set(all)];
  },[merged, responseData]);

  const funnelStats = useMemo(()=>[
    {name:"전체 환불", value:summary.total, fill:"#6366f1"},
    {name:"계정 제재", value:summary.sanction, fill:"#ef4444"},
    {name:"복구 문의", value:respSummary.uniqueUsers, fill:"#f59e0b"},
    {name:"복구 완료", value:respSummary.recovered, fill:"#22c55e"},
  ],[summary, respSummary]);

  const hasData = merged.length>0;

  // ── 공통 필터바 ──
  const filterBar = (showPeriod=true, periodVal, setPeriodVal) => (
    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14,alignItems:"center"}}>
      <DateFilter from={from} to={to} onFrom={setFrom} onTo={setTo} onReset={()=>{setFrom("2018-01-01");setTo("2026-12-31");}}/>
      {showPeriod && (
        <div style={{display:"flex",background:"#1e293b",borderRadius:8,overflow:"hidden"}}>
          {PERIOD_TABS.map(t=>(
            <button key={t.id} onClick={()=>(setPeriodVal||setPeriod)(t.id)}
              style={{padding:"6px 12px",border:"none",background:(periodVal||period)===t.id?"#6366f1":"transparent",
                color:(periodVal||period)===t.id?"#fff":"#94a3b8",cursor:"pointer",fontSize:12,fontWeight:(periodVal||period)===t.id?700:400}}>
              {t.l}
            </button>
          ))}
        </div>
      )}
      <select value={country} onChange={e=>setCountry(e.target.value)}
        style={{padding:"6px 10px",borderRadius:8,border:"1px solid #334155",background:"#1e293b",color:"#e2e8f0",fontSize:12}}>
        {countries.map(c=><option key={c}>{c}</option>)}
      </select>
      <select value={platform} onChange={e=>setPlatform(e.target.value)}
        style={{padding:"6px 10px",borderRadius:8,border:"1px solid #334155",background:"#1e293b",color:"#e2e8f0",fontSize:12}}>
        {["전체","Google","iOS"].map(p=><option key={p}>{p}</option>)}
      </select>
    </div>
  );

  // ── 업로드 박스 ──
  const UploadBox = () => (
    <div style={{background:"#1e293b",borderRadius:12,padding:16,marginBottom:12}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
        <span style={{fontSize:13,fontWeight:600,color:"#e2e8f0"}}>📁 엑셀 업로드 (시트 2개 포함)</span>
        {hasData && <button onClick={()=>{setRefundData([]);setProcessData([]);setSheetLog([]);setFileName("");}}
          style={{padding:"4px 10px",borderRadius:6,border:"1px solid #334155",background:"transparent",color:"#64748b",cursor:"pointer",fontSize:11}}>재업로드</button>}
      </div>
      {sheetLog.map((l,i)=><div key={i} style={{fontSize:12,color:l.startsWith("✅")?"#22c55e":l.startsWith("⚠️")?"#f59e0b":"#64748b",marginBottom:3}}>{l}</div>)}
      {hasData ? (
        <div style={{fontSize:12,color:"#22c55e",marginTop:4}}>📂 {fileName} · 총 {merged.length.toLocaleString()}건</div>
      ) : (
        <div onDrop={onDrop} onDragOver={e=>e.preventDefault()}
          onClick={()=>{const i=document.createElement("input");i.type="file";i.accept=".xlsx,.xls";i.onchange=e=>parseFile(e.target.files[0]);i.click();}}
          style={{border:"2px dashed #334155",borderRadius:8,padding:"22px",textAlign:"center",cursor:"pointer",marginTop:8}}>
          {uploading ? <div style={{color:"#6366f1",fontSize:13}}>⏳ 시트 분석 중...</div> : (<>
            <div style={{fontSize:26,marginBottom:6}}>📂</div>
            <div style={{color:"#e2e8f0",fontSize:13,fontWeight:600,marginBottom:3}}>드래그 또는 클릭하여 업로드</div>
            <div style={{color:"#64748b",fontSize:12}}>시트1: 환불 원본 | 시트2: 처리결과 · 자동 구분</div>
          </>)}
          {uploadErr && <div style={{color:"#ef4444",fontSize:12,marginTop:8}}>{uploadErr}</div>}
        </div>
      )}
    </div>
  );

  return (
    <div style={{fontFamily:"sans-serif",background:"#0f172a",minHeight:"100vh",color:"#e2e8f0",padding:"16px"}}>
      {/* 헤더 */}
      <div style={{marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:8}}>
        <div>
          <h1 style={{fontSize:20,fontWeight:700,color:"#fff",margin:0}}>🎮 환불 현황 대시보드</h1>
          <p style={{color:"#64748b",fontSize:12,margin:"4px 0 0"}}>Google Play · iOS · 한국 · 일본</p>
        </div>
        <div style={{display:"flex",gap:10,fontSize:11,alignItems:"center"}}>
          <span style={{color:hasData?"#22c55e":"#475569"}}>{hasData?"✅":"⬜"} 환불데이터 {hasData?fmt(merged.length)+"건":""}</span>
          <span style={{color:responseData.length?"#22c55e":"#475569"}}>{responseData.length?"✅":"⬜"} 대응현황 {responseData.length?`${fmt(responseData.length)}행 (${fmt(Object.keys(uniqueOpenids).length)}명)`:""}</span>
        </div>
      </div>

      {/* 탭 */}
      <div style={{display:"flex",gap:2,marginBottom:14,background:"#1e293b",borderRadius:10,padding:4,flexWrap:"wrap",width:"fit-content"}}>
        {MAIN_TABS.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{padding:"7px 14px",border:"none",borderRadius:8,
              background:tab===t?"#6366f1":"transparent",
              color:tab===t?"#fff":"#94a3b8",cursor:"pointer",fontSize:12,fontWeight:tab===t?700:400}}>
            {t}
          </button>
        ))}
      </div>

      {/* ── 환불 현황 ── */}
      {tab==="환불 현황" && (<>
        <UploadBox/>
        {!hasData && <div style={{background:"#1e293b",borderRadius:12,padding:24,textAlign:"center",color:"#64748b",fontSize:13}}>파일을 업로드하면 데이터가 표시됩니다.</div>}
        {hasData && (<>
          {filterBar(true, period, setPeriod)}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:10,marginBottom:14}}>
            <Card icon="📊" label="전체 환불" value={fmt(summary.total)} color="#6366f1"/>
            <Card icon="🤖" label="Google" value={fmt(summary.google)} color="#4285F4"/>
            <Card icon="🍎" label="iOS" value={fmt(summary.ios)} color="#A855F7"/>
            <Card icon="✅" label="회수처리" value={fmt(summary.recover)} color="#22d3ee"/>
            <Card icon="🚫" label="제재처리" value={fmt(summary.sanction)} color="#ef4444"/>
            <Card icon="💰" label="환불금액" value={fmtKRW(summary.totalAmt)} color="#22c55e"/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:12,marginBottom:12}}>
            <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
              <div style={{fontSize:13,color:"#94a3b8",marginBottom:12}}>플랫폼별 환불 추이</div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={trendData}><CartesianGrid strokeDasharray="3 3" stroke="#334155"/>
                  <XAxis dataKey="name" tick={{fill:"#64748b",fontSize:10}}/><YAxis tick={{fill:"#64748b",fontSize:10}}/>
                  <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:11}}/>
                  <Bar dataKey="Google" fill="#4285F4" radius={[3,3,0,0]}/><Bar dataKey="iOS" fill="#A855F7" radius={[3,3,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
              <div style={{fontSize:13,color:"#94a3b8",marginBottom:10}}>플랫폼 비율</div>
              <ResponsiveContainer width="100%" height={130}><PieChart>
                <Pie data={piePlatform} cx="50%" cy="50%" innerRadius={35} outerRadius={58} dataKey="value" paddingAngle={3}>
                  {piePlatform.map((e,i)=><Cell key={i} fill={e.color}/>)}</Pie><Tooltip {...TT}/>
              </PieChart></ResponsiveContainer>
              {piePlatform.map(d=>(<div key={d.name} style={{display:"flex",alignItems:"center",gap:6,fontSize:12,marginTop:6}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:d.color}}/><span style={{color:"#94a3b8"}}>{d.name}</span>
                <span style={{marginLeft:"auto",fontWeight:600}}>{fmt(d.value)}건</span></div>))}
            </div>
          </div>
          <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
            <div style={{fontSize:13,color:"#94a3b8",marginBottom:10}}>환불 금액 추이</div>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={trendData}><CartesianGrid strokeDasharray="3 3" stroke="#334155"/>
                <XAxis dataKey="name" tick={{fill:"#64748b",fontSize:10}}/><YAxis tick={{fill:"#64748b",fontSize:10}} tickFormatter={v=>"₩"+(v/10000).toFixed(0)+"만"}/>
                <Tooltip {...TT} formatter={v=>fmtKRW(v)}/><Line type="monotone" dataKey="totalAmt" name="환불금액" stroke="#22d3ee" strokeWidth={2} dot={false}/>
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>)}
      </>)}

      {/* ── 처리 유형 ── */}
      {tab==="처리 유형" && (<>
        {!hasData && <div style={{background:"#1e293b",borderRadius:12,padding:24,textAlign:"center",color:"#64748b",fontSize:13}}>← 환불 현황 탭에서 파일을 먼저 업로드해주세요.</div>}
        {hasData && (<>
          {filterBar(true, period, setPeriod)}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:14}}>
            <Card icon="✅" label="회수처리" value={fmt(filtered.filter(d=>d.type==="회수처리").length)} color="#22d3ee"/>
            <Card icon="🚫" label="제재처리" value={fmt(filtered.filter(d=>d.type==="제재처리").length)} color="#ef4444"/>
            <Card icon="🎧" label="고객센터환불" value={fmt(filtered.filter(d=>d.type==="고객센터환불").length)} color="#6366f1"/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:12}}>
            <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
              <div style={{fontSize:13,color:"#94a3b8",marginBottom:12}}>처리 유형별 추이</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={typeData}><CartesianGrid strokeDasharray="3 3" stroke="#334155"/>
                  <XAxis dataKey="name" tick={{fill:"#64748b",fontSize:10}}/><YAxis tick={{fill:"#64748b",fontSize:10}}/>
                  <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:11}}/>
                  <Bar dataKey="회수처리" fill="#22d3ee" radius={[3,3,0,0]}/><Bar dataKey="제재처리" fill="#ef4444" radius={[3,3,0,0]}/>
                  <Bar dataKey="고객센터환불" fill="#6366f1" radius={[3,3,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
              <div style={{fontSize:13,color:"#94a3b8",marginBottom:10}}>유형 비율</div>
              <ResponsiveContainer width="100%" height={140}><PieChart>
                <Pie data={pieType} cx="50%" cy="50%" innerRadius={35} outerRadius={58} dataKey="value" paddingAngle={3}>
                  {pieType.map((e,i)=><Cell key={i} fill={e.color}/>)}</Pie><Tooltip {...TT}/>
              </PieChart></ResponsiveContainer>
              {pieType.map(d=>(<div key={d.name} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,marginTop:6}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:d.color}}/><span style={{color:"#94a3b8"}}>{d.name}</span>
                <span style={{marginLeft:"auto",fontWeight:600}}>{fmt(d.value)}건</span></div>))}
            </div>
          </div>
        </>)}
      </>)}

      {/* ── 대응 현황 ── */}
      {tab==="대응 현황" && (<>
        <div style={{background:"#1e293b",borderRadius:12,padding:16,marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div>
              <div style={{fontSize:13,fontWeight:600,color:"#e2e8f0",marginBottom:4}}>🔗 Google Sheets 대응현황</div>
              <div style={{fontSize:11,color:"#64748b"}}>Viz API → 직접 연결 → CORS 프록시 (자동 폴백) + 🤖 AI 컬럼 자동 분석</div>
            </div>
            {lastFetch && <span style={{fontSize:11,color:"#22c55e"}}>✅ {lastFetch} 갱신</span>}
          </div>
          <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
            <button onClick={fetchSheet} disabled={sheetLoading}
              style={{padding:"10px 24px",borderRadius:8,border:"none",
                background:sheetLoading?"#475569":"#6366f1",
                color:"#fff",cursor:sheetLoading?"wait":"pointer",fontSize:13,fontWeight:700}}>
              {sheetLoading?"⏳ 불러오는 중...":responseData.length?"🔄 새로고침":"📡 대응현황 불러오기"}
            </button>
            {SHEET_TARGETS.map((t,i)=>(
              <span key={i} style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:"#0f172a",color:"#64748b"}}>{t.label}</span>
            ))}
          </div>
          {aiStatus && <div style={{fontSize:11,color:aiStatus.includes("✅")?"#22c55e":aiStatus.includes("⚠️")?"#f59e0b":"#6366f1",marginTop:6}}>{aiStatus}</div>}
          {sheetErr && <div style={{color:"#ef4444",fontSize:12,marginTop:8}}>{sheetErr}</div>}
          {sheetStatus.length>0 && (
            <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10}}>
              {sheetStatus.map((s,i)=>(<div key={i} style={{fontSize:11,padding:"4px 10px",borderRadius:6,
                background:s.ok?"#14532d":"#450a0a", color:s.ok?"#22c55e":"#ef4444"}}>
                {s.ok?"✅":"❌"} {s.label} {s.ok?`(${s.count}행 · ${s.method})`:s.err}</div>))}
            </div>
          )}
        </div>

        {responseData.length===0 ? (
          <div style={{background:"#1e293b",borderRadius:12,padding:32,textAlign:"center",color:"#64748b",fontSize:13}}>
            위 버튼을 클릭하면 Google Sheets에서 실시간 데이터를 불러옵니다.
          </div>
        ) : (<>
          {filterBar(true, respPeriod, setRespPeriod)}

          {/* 요약 카드 — openid 기준 */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(110px,1fr))",gap:10,marginBottom:14}}>
            <Card icon="📊" label="총 데이터행" value={fmt(respFiltered.length)} sub={`${fmt(respSummary.uniqueUsers)}명 (유니크)`} color="#6366f1"/>
            <Card icon="✅" label="복구완료" value={fmt(respSummary.recovered)} sub={`${respSummary.uniqueUsers?Math.round(respSummary.recovered/respSummary.uniqueUsers*100):0}%`} color="#22c55e"/>
            <Card icon="⏳" label="처리중" value={fmt(respSummary.processing)} sub={`${respSummary.uniqueUsers?Math.round(respSummary.processing/respSummary.uniqueUsers*100):0}%`} color="#22d3ee"/>
            <Card icon="🚫" label="재제재" value={fmt(respSummary.resanctioned)} sub={`${respSummary.uniqueUsers?Math.round(respSummary.resanctioned/respSummary.uniqueUsers*100):0}%`} color="#ef4444"/>
          </div>

          {/* 대응현황 추이 차트 */}
          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:12,marginBottom:14}}>
            <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
              <div style={{fontSize:13,color:"#94a3b8",marginBottom:12}}>대응현황 추이 (날짜 기준)</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={respTrendData}><CartesianGrid strokeDasharray="3 3" stroke="#334155"/>
                  <XAxis dataKey="name" tick={{fill:"#64748b",fontSize:10}}/><YAxis tick={{fill:"#64748b",fontSize:10}}/>
                  <Tooltip {...TT}/><Legend wrapperStyle={{fontSize:11}}/>
                  <Bar dataKey="복구완료" fill="#22c55e" radius={[3,3,0,0]} stackId="a"/>
                  <Bar dataKey="처리중" fill="#22d3ee" radius={[0,0,0,0]} stackId="a"/>
                  <Bar dataKey="재제재" fill="#ef4444" radius={[3,3,0,0]} stackId="a"/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
              <div style={{fontSize:13,color:"#94a3b8",marginBottom:10}}>상태 비율 (유저 기준)</div>
              <ResponsiveContainer width="100%" height={140}><PieChart>
                <Pie data={pieResp} cx="50%" cy="50%" innerRadius={35} outerRadius={58} dataKey="value" paddingAngle={3}>
                  {pieResp.map((e,i)=><Cell key={i} fill={e.color}/>)}</Pie><Tooltip {...TT}/>
              </PieChart></ResponsiveContainer>
              {pieResp.map(d=>(<div key={d.name} style={{display:"flex",alignItems:"center",gap:6,fontSize:12,marginTop:6}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:d.color}}/><span style={{color:"#94a3b8"}}>{d.name}</span>
                <span style={{marginLeft:"auto",fontWeight:600}}>{fmt(d.value)}명</span></div>))}
            </div>
          </div>

          {/* 국가/플랫폼별 카드 */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:12,marginBottom:14}}>
            {["한국_Google","한국_iOS","일본_Google","일본_iOS"].map(key=>{
              const [c,p]=key.split("_");
              const rows=respFiltered.filter(d=>d.country===c&&d.platform===p);
              const uids = {};
              rows.forEach(d=>{ if(!uids[d.openid]) uids[d.openid]={status:d.status}; if(d.status==="복구완료") uids[d.openid].status="복구완료"; if(d.status==="재제재") uids[d.openid].status="재제재"; });
              const vals = Object.values(uids);
              const done=vals.filter(d=>d.status==="복구완료").length;
              const ing=vals.filter(d=>d.status==="처리중").length;
              const resan=vals.filter(d=>d.status==="재제재").length;
              const total=vals.length;
              return (
                <div key={key} style={{background:"#1e293b",borderRadius:12,padding:16,borderLeft:`4px solid ${p==="Google"?"#4285F4":"#A855F7"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                    <span style={{fontWeight:700,fontSize:13}}>{c} {p==="Google"?"🤖":"🍎"} {p}</span>
                    <span style={{fontSize:11,color:"#64748b"}}>{fmt(rows.length)}행 · {fmt(total)}명</span>
                  </div>
                  {[["복구완료",done,"#22c55e"],["처리중",ing,"#22d3ee"],["재제재",resan,"#ef4444"]].map(([l,v,col])=>(
                    <div key={l} style={{marginBottom:8}}>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}>
                        <span style={{color:"#64748b"}}>{l}</span>
                        <span style={{color:col,fontWeight:600}}>{fmt(v)}명 ({total?Math.round(v/total*100):0}%)</span>
                      </div>
                      <div style={{background:"#0f172a",borderRadius:4,height:6}}>
                        <div style={{width:`${total?Math.round(v/total*100):0}%`,height:"100%",background:col,borderRadius:4}}/>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>

          {/* 테이블 */}
          <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
            <div style={{fontSize:13,color:"#94a3b8",marginBottom:12}}>최근 대응 내역 (최신 50건)</div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead><tr style={{borderBottom:"1px solid #334155"}}>
                  {["문의일","OpenID","해제일시","처리날짜","처리결과","상태"].map(h=>(
                    <th key={h} style={{padding:"6px 8px",textAlign:"left",color:"#64748b",whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {respFiltered.slice(-50).reverse().map((r,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid #0f172a",background:i%2===0?"#0f172a":"transparent"}}>
                      <td style={{padding:"6px 8px",color:"#94a3b8",whiteSpace:"nowrap"}}>{r.date}</td>
                      <td style={{padding:"6px 8px",color:"#e2e8f0",fontSize:10,maxWidth:160,overflow:"hidden",textOverflow:"ellipsis"}}>{r.openid}</td>
                      <td style={{padding:"6px 8px",color:"#22d3ee",whiteSpace:"nowrap"}}>{r.releaseDate||"-"}</td>
                      <td style={{padding:"6px 8px",color:"#94a3b8",whiteSpace:"nowrap"}}>{r.processDate||"-"}</td>
                      <td style={{padding:"6px 8px",color:"#e2e8f0",maxWidth:200,overflow:"hidden",textOverflow:"ellipsis"}}>{r.processResult||"-"}</td>
                      <td style={{padding:"6px 8px"}}>
                        <span style={{padding:"2px 7px",borderRadius:4,fontSize:10,whiteSpace:"nowrap",
                          background:r.resanctioned?"#450a0a":r.status==="복구완료"?"#14532d":"#164e63",
                          color:r.resanctioned?"#ef4444":r.status==="복구완료"?"#22c55e":"#22d3ee"}}>{r.status}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>)}
      </>)}

      {/* ── 퍼널 통계 ── */}
      {tab==="퍼널 통계" && (<>
        {filterBar(false)}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:10,marginBottom:14}}>
          {funnelStats.map(f=>(
            <div key={f.name} style={{background:"#1e293b",borderRadius:12,padding:"14px 16px",borderTop:`3px solid ${f.fill}`}}>
              <div style={{fontSize:11,color:"#64748b",marginBottom:4}}>{f.name}</div>
              <div style={{fontSize:20,fontWeight:700,color:f.fill}}>{fmt(f.value)}</div>
              <div style={{fontSize:11,color:"#64748b",marginTop:2}}>
                {f.name!=="전체 환불"&&funnelStats[0].value>0?`전체 대비 ${Math.round(f.value/funnelStats[0].value*100)}%`:""}
              </div>
            </div>
          ))}
        </div>
        <div style={{background:"#1e293b",borderRadius:12,padding:24}}>
          <div style={{fontSize:13,color:"#94a3b8",marginBottom:20}}>환불 → 제재 → 문의 → 복구 퍼널</div>
          <div style={{display:"flex",flexDirection:"column",gap:10,alignItems:"center"}}>
            {funnelStats.map((f,i)=>{
              const pct=funnelStats[0].value?Math.max(Math.round(f.value/funnelStats[0].value*100),5):5;
              return(<div key={f.name} style={{width:"100%",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                <div style={{width:`${pct}%`,background:f.fill,borderRadius:8,padding:"11px 0",textAlign:"center",minWidth:60}}>
                  <span style={{fontWeight:700,fontSize:13}}>{fmt(f.value)}</span></div>
                <div style={{display:"flex",gap:6}}><span style={{fontSize:12,color:"#94a3b8"}}>{f.name}</span>
                  {i>0&&funnelStats[0].value>0&&<span style={{fontSize:11,color:f.fill}}>({Math.round(f.value/funnelStats[0].value*100)}%)</span>}</div>
                {i<funnelStats.length-1&&<div style={{fontSize:14,color:"#334155"}}>▼</div>}
              </div>);
            })}
          </div>
        </div>
      </>)}

      {/* ── 분석 리포트 (유관 기관 요청용) ── */}
      {tab==="분석 리포트" && (<>
        <div style={{background:"#1e293b",borderRadius:12,padding:20,marginBottom:14}}>
          <div style={{fontSize:15,fontWeight:700,color:"#fff",marginBottom:6}}>📋 환불 대응 분석 리포트</div>
          <div style={{fontSize:12,color:"#64748b",marginBottom:16}}>유관 기관 요청 시 기간을 선택하면 바로 리포트를 생성합니다.</div>
          {filterBar(false)}
        </div>

        {/* 핵심 요약 카드 */}
        <div style={{background:"linear-gradient(135deg, #1e293b 0%, #0f172a 100%)",borderRadius:16,padding:24,marginBottom:14,border:"1px solid #334155"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0",marginBottom:4}}>📊 기간 요약</div>
          <div style={{fontSize:11,color:"#64748b",marginBottom:20}}>{from} ~ {to}</div>

          <div style={{display:"flex",gap:0,alignItems:"center",justifyContent:"center",flexWrap:"wrap"}}>
            {[
              {label:"앱마켓 환불", value:fmt(summary.total), sub:"명 (총 환불 건수)", color:"#6366f1", icon:"📱"},
              {label:"계정 정지", value:fmt(summary.sanction), sub:`명 (환불자의 ${summary.total?Math.round(summary.sanction/summary.total*100):0}%)`, color:"#ef4444", icon:"🔒"},
              {label:"복구 문의", value:fmt(respSummary.uniqueUsers), sub:`명 (정지자의 ${summary.sanction?Math.round(respSummary.uniqueUsers/summary.sanction*100):0}%)`, color:"#f59e0b", icon:"📞"},
              {label:"복구 완료", value:fmt(respSummary.recovered), sub:`명 (문의자의 ${respSummary.uniqueUsers?Math.round(respSummary.recovered/respSummary.uniqueUsers*100):0}%)`, color:"#22c55e", icon:"✅"},
              {label:"재제재", value:fmt(respSummary.resanctioned), sub:`명 (문의자의 ${respSummary.uniqueUsers?Math.round(respSummary.resanctioned/respSummary.uniqueUsers*100):0}%)`, color:"#ef4444", icon:"🚫"},
            ].map((item,idx)=>(
              <div key={item.label} style={{display:"flex",alignItems:"center"}}>
                <div style={{textAlign:"center",padding:"12px 18px"}}>
                  <div style={{fontSize:10,color:"#64748b",marginBottom:4}}>{item.icon} {item.label}</div>
                  <div style={{fontSize:28,fontWeight:800,color:item.color}}>{item.value}</div>
                  <div style={{fontSize:10,color:"#94a3b8",marginTop:2}}>{item.sub}</div>
                </div>
                {idx < 4 && <div style={{fontSize:20,color:"#334155",padding:"0 4px"}}>→</div>}
              </div>
            ))}
          </div>
        </div>

        {/* 텍스트 리포트 */}
        <div style={{background:"#1e293b",borderRadius:12,padding:20,marginBottom:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <div style={{fontSize:14,fontWeight:700,color:"#e2e8f0"}}>📝 텍스트 리포트</div>
            <button onClick={()=>{
              const text = `[환불 대응 분석 리포트]\n기간: ${from} ~ ${to}\n\n` +
                `1. 앱마켓 환불: ${fmt(summary.total)}명\n` +
                `2. 계정 정지: ${fmt(summary.sanction)}명 (환불자의 ${summary.total?Math.round(summary.sanction/summary.total*100):0}%)\n` +
                `3. 복구 문의: ${fmt(respSummary.uniqueUsers)}명 (정지자의 ${summary.sanction?Math.round(respSummary.uniqueUsers/summary.sanction*100):0}%)\n` +
                `4. 복구 완료: ${fmt(respSummary.recovered)}명 (문의자의 ${respSummary.uniqueUsers?Math.round(respSummary.recovered/respSummary.uniqueUsers*100):0}%)\n` +
                `5. 재제재 (미재결제): ${fmt(respSummary.resanctioned)}명 (문의자의 ${respSummary.uniqueUsers?Math.round(respSummary.resanctioned/respSummary.uniqueUsers*100):0}%)\n\n` +
                `[요약]\n${from}~${to} 기간 동안 총 ${fmt(summary.total)}명이 앱 마켓 환불을 진행하였으며, ` +
                `그 중 ${fmt(summary.sanction)}명의 계정이 정지되었습니다. ` +
                `정지된 계정 중 ${fmt(respSummary.uniqueUsers)}명이 복구를 문의하였고, ` +
                `${fmt(respSummary.recovered)}명이 재결제 후 복구 완료되었습니다. ` +
                `${fmt(respSummary.resanctioned)}명은 재결제를 하지 않아 재제재되었습니다.`;
              navigator.clipboard.writeText(text);
              alert("리포트가 클립보드에 복사되었습니다!");
            }}
              style={{padding:"8px 16px",borderRadius:8,border:"none",background:"#6366f1",color:"#fff",cursor:"pointer",fontSize:12,fontWeight:600}}>
              📋 복사
            </button>
          </div>
          <div style={{background:"#0f172a",borderRadius:8,padding:16,fontSize:13,lineHeight:1.8,color:"#e2e8f0"}}>
            <div style={{color:"#6366f1",fontWeight:700,marginBottom:8}}>[ 환불 대응 분석 리포트 ]</div>
            <div style={{color:"#64748b",marginBottom:12}}>기간: {from} ~ {to}</div>
            <div style={{marginBottom:6}}>1. <span style={{color:"#6366f1"}}>앱마켓 환불</span>: <strong>{fmt(summary.total)}</strong>명</div>
            <div style={{marginBottom:6}}>2. <span style={{color:"#ef4444"}}>계정 정지</span>: <strong>{fmt(summary.sanction)}</strong>명 <span style={{color:"#64748b"}}>(환불자의 {summary.total?Math.round(summary.sanction/summary.total*100):0}%)</span></div>
            <div style={{marginBottom:6}}>3. <span style={{color:"#f59e0b"}}>복구 문의</span>: <strong>{fmt(respSummary.uniqueUsers)}</strong>명 <span style={{color:"#64748b"}}>(정지자의 {summary.sanction?Math.round(respSummary.uniqueUsers/summary.sanction*100):0}%)</span></div>
            <div style={{marginBottom:6}}>4. <span style={{color:"#22c55e"}}>복구 완료</span>: <strong>{fmt(respSummary.recovered)}</strong>명 <span style={{color:"#64748b"}}>(문의자의 {respSummary.uniqueUsers?Math.round(respSummary.recovered/respSummary.uniqueUsers*100):0}%)</span></div>
            <div style={{marginBottom:12}}>5. <span style={{color:"#ef4444"}}>재제재</span>: <strong>{fmt(respSummary.resanctioned)}</strong>명 <span style={{color:"#64748b"}}>(문의자의 {respSummary.uniqueUsers?Math.round(respSummary.resanctioned/respSummary.uniqueUsers*100):0}%)</span></div>
            <div style={{borderTop:"1px solid #334155",paddingTop:12,color:"#94a3b8",fontSize:12}}>
              <strong style={{color:"#e2e8f0"}}>[요약]</strong> {from}~{to} 기간 동안 총 <strong style={{color:"#6366f1"}}>{fmt(summary.total)}명</strong>이 앱 마켓 환불을 진행하였으며,
              그 중 <strong style={{color:"#ef4444"}}>{fmt(summary.sanction)}명</strong>의 계정이 정지되었습니다.
              정지된 계정 중 <strong style={{color:"#f59e0b"}}>{fmt(respSummary.uniqueUsers)}명</strong>이 복구를 문의하였고,
              <strong style={{color:"#22c55e"}}>{fmt(respSummary.recovered)}명</strong>이 재결제 후 복구 완료되었습니다.
              <strong style={{color:"#ef4444"}}>{fmt(respSummary.resanctioned)}명</strong>은 재결제를 하지 않아 재제재되었습니다.
            </div>
          </div>
        </div>

        {/* 퍼널 시각화 */}
        <div style={{background:"#1e293b",borderRadius:12,padding:24}}>
          <div style={{fontSize:13,color:"#94a3b8",marginBottom:20}}>환불 → 정지 → 문의 → 복구 퍼널</div>
          <div style={{display:"flex",flexDirection:"column",gap:10,alignItems:"center"}}>
            {[
              {name:"앱마켓 환불", value:summary.total, fill:"#6366f1"},
              {name:"계정 정지", value:summary.sanction, fill:"#ef4444"},
              {name:"복구 문의", value:respSummary.uniqueUsers, fill:"#f59e0b"},
              {name:"복구 완료", value:respSummary.recovered, fill:"#22c55e"},
              {name:"재제재", value:respSummary.resanctioned, fill:"#ef4444"},
            ].map((f,i,arr)=>{
              const maxVal = arr[0].value || 1;
              const pct = Math.max(Math.round(f.value/maxVal*100),3);
              return(<div key={f.name} style={{width:"100%",display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
                <div style={{width:`${pct}%`,background:f.fill,borderRadius:8,padding:"12px 0",textAlign:"center",minWidth:80}}>
                  <span style={{fontWeight:700,fontSize:14}}>{fmt(f.value)}명</span></div>
                <div style={{display:"flex",gap:6}}><span style={{fontSize:12,color:"#94a3b8"}}>{f.name}</span>
                  {i>0&&<span style={{fontSize:11,color:f.fill}}>({Math.round(f.value/maxVal*100)}%)</span>}</div>
                {i<arr.length-1&&<div style={{fontSize:14,color:"#334155"}}>▼</div>}
              </div>);
            })}
          </div>
        </div>
      </>)}

      {/* ── 프로세스 안내 ── */}
      {tab==="프로세스 안내" && (<>
        <div style={{background:"#1e293b",borderRadius:12,padding:24,marginBottom:14}}>
          <div style={{fontSize:16,fontWeight:700,color:"#fff",marginBottom:6}}>📖 PUBGM 환불 대응 프로세스 안내</div>
          <div style={{fontSize:12,color:"#64748b"}}>환불 처리 절차 및 계정 정지/해제 과정에 대한 안내입니다.</div>
        </div>

        {/* 계정 정지 이유 */}
        <div style={{background:"#1e293b",borderRadius:12,padding:20,marginBottom:14,borderLeft:"4px solid #ef4444"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#ef4444",marginBottom:12}}>❓ 왜 계정을 정지하나요?</div>
          <div style={{fontSize:13,color:"#e2e8f0",lineHeight:1.8,marginBottom:12}}>
            고객센터를 통하지 않고 <strong style={{color:"#f59e0b"}}>앱 마켓(구글 플레이스토어, 애플 앱스토어)을 통해 직접 환불</strong>을 진행한 경우,
            데이터 확인을 통해 해당 결제로 지급된 <strong style={{color:"#22d3ee"}}>재화(UC)의 사용 여부를 검토</strong> 후 조치합니다.
          </div>
          <div style={{background:"#0f172a",borderRadius:8,padding:14,display:"flex",gap:12,alignItems:"center"}}>
            <div style={{fontSize:28}}>💡</div>
            <div style={{fontSize:12,color:"#f59e0b",lineHeight:1.6}}>
              <strong>핵심:</strong> 환불은 받았으나 재화는 이미 사용된 상태 → 결과적으로 <strong>무료로 유료 콘텐츠를 이용</strong>한 것이므로 계정 정지
            </div>
          </div>
        </div>

        {/* 계정 정지 과정 */}
        <div style={{background:"#1e293b",borderRadius:12,padding:20,marginBottom:14,borderLeft:"4px solid #f59e0b"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#f59e0b",marginBottom:16}}>🔒 계정 정지 과정</div>
          <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {[
              {step:"1", title:"환불 데이터 추출", desc:"앱 마켓(Google Play / App Store)에서 환불 데이터를 추출합니다.", icon:"📱"},
              {step:"2", title:"재화(UC) 사용 여부 확인", desc:"해당 결제로 지급된 재화(UC)의 사용 여부를 데이터로 확인합니다.", icon:"🔍"},
              {step:"3-1", title:"재화 보유 시 → 재화 회수", desc:"지급된 재화를 아직 보유하고 있는 경우, 재화만 회수하고 계정 정지 없음.", icon:"✅", color:"#22c55e"},
              {step:"3-2", title:"재화 사용 시 → 계정 정지", desc:"지급된 재화를 이미 사용한 경우, 계정을 정지합니다.", icon:"🔒", color:"#ef4444"},
            ].map((item,i)=>(
              <div key={i} style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                  <div style={{width:36,height:36,borderRadius:"50%",background:item.color||"#334155",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:"#fff",flexShrink:0}}>
                    {item.step}
                  </div>
                  {i<3 && <div style={{width:2,height:30,background:"#334155"}}/>}
                </div>
                <div style={{paddingBottom:i<3?14:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:"#e2e8f0",marginBottom:3}}>{item.icon} {item.title}</div>
                  <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.5}}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 계정 해제 과정 */}
        <div style={{background:"#1e293b",borderRadius:12,padding:20,marginBottom:14,borderLeft:"4px solid #22c55e"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#22c55e",marginBottom:16}}>🔓 계정 해제 과정</div>
          <div style={{display:"flex",flexDirection:"column",gap:0}}>
            {[
              {step:"1", title:"고객센터 문의 접수", desc:"정지된 유저가 고객센터로 계정 해제를 문의합니다.", icon:"📞"},
              {step:"2", title:"환불 결제 건 안내", desc:"환불 진행한 결제 건을 유저에게 안내합니다.", icon:"📋"},
              {step:"3", title:"재결제 필요 안내", desc:"환불받은 금액만큼 재결제가 필요함을 안내합니다. (상세 재결제 상품 안내)", icon:"💳"},
              {step:"4", title:"이용자 재결제 완료", desc:"유저가 안내받은 상품을 재결제합니다.", icon:"✅"},
              {step:"5", title:"재화 회수 및 계정 해제 완료", desc:"재결제로 지급된 재화를 회수하고 계정 정지를 해제합니다.", icon:"🎉"},
            ].map((item,i)=>(
              <div key={i} style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                  <div style={{width:36,height:36,borderRadius:"50%",background:"#22c55e",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:700,color:"#fff",flexShrink:0}}>
                    {item.step}
                  </div>
                  {i<4 && <div style={{width:2,height:30,background:"#334155"}}/>}
                </div>
                <div style={{paddingBottom:i<4?14:0}}>
                  <div style={{fontSize:13,fontWeight:600,color:"#e2e8f0",marginBottom:3}}>{item.icon} {item.title}</div>
                  <div style={{fontSize:12,color:"#94a3b8",lineHeight:1.5}}>{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* 처리결과 분류 기준 */}
        <div style={{background:"#1e293b",borderRadius:12,padding:20,borderLeft:"4px solid #6366f1"}}>
          <div style={{fontSize:14,fontWeight:700,color:"#6366f1",marginBottom:14}}>📊 대시보드 처리결과 분류 기준</div>
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
            {[
              {status:"복구완료", desc:"재화 회수 완료 / 계정 해제 / 이벤트 해제 등 처리가 완료된 건", color:"#22c55e", icon:"✅", keywords:"회수, 완료, 해제"},
              {status:"처리중", desc:"처리결과가 아직 기록되지 않은 건 (빈칸)", color:"#22d3ee", icon:"⏳", keywords:"빈칸"},
              {status:"재제재", desc:"재결제를 하지 않아 다시 계정을 정지한 건", color:"#ef4444", icon:"🚫", keywords:"정지, 재제재, 제재"},
            ].map(item=>(
              <div key={item.status} style={{background:"#0f172a",borderRadius:8,padding:14,borderTop:`3px solid ${item.color}`}}>
                <div style={{fontSize:20,marginBottom:6}}>{item.icon}</div>
                <div style={{fontSize:14,fontWeight:700,color:item.color,marginBottom:6}}>{item.status}</div>
                <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.5,marginBottom:8}}>{item.desc}</div>
                <div style={{fontSize:10,color:"#64748b"}}>키워드: <span style={{color:item.color}}>{item.keywords}</span></div>
              </div>
            ))}
          </div>
        </div>
      </>)}

      {/* ── 유저 조회 ── */}
      {tab==="유저 조회" && <UserSearch refundData={merged} responseData={responseData}/>}

      <div style={{marginTop:14,padding:"10px 14px",background:"#1e293b",borderRadius:8,fontSize:11,color:"#475569",borderLeft:"3px solid #6366f1"}}>
        💡 환불현황: 엑셀 업로드 · 대응현황: Google Sheets 실시간 + AI 자동 분석 · openid 기준 집계
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 유저 조회
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function UserSearch({refundData, responseData}) {
  const [q, setQ] = useState("");
  const [res, setRes] = useState(null);
  const search = () => {
    const s=q.trim(); if(!s) return;
    setRes({
      q:s,
      refunds: refundData.filter(d=>String(d.openid||"").includes(s)||String(d.orderNo||"").includes(s)),
      responses: responseData.filter(d=>String(d.openid||"").includes(s)),
    });
  };
  return (
    <div>
      <div style={{display:"flex",gap:8,marginBottom:16}}>
        <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&search()}
          placeholder="OpenID 입력 후 Enter"
          style={{flex:1,padding:"10px 14px",borderRadius:8,border:"1px solid #334155",background:"#1e293b",color:"#e2e8f0",fontSize:13,outline:"none"}}/>
        <button onClick={search}
          style={{padding:"10px 20px",borderRadius:8,border:"none",background:"#6366f1",color:"#fff",cursor:"pointer",fontWeight:700,fontSize:13}}>조회</button>
      </div>
      {!res && <div style={{background:"#1e293b",borderRadius:10,padding:24,color:"#64748b",textAlign:"center",fontSize:13}}>🔍 OpenID를 입력하세요.</div>}
      {res && res.refunds.length===0 && res.responses.length===0 && (
        <div style={{background:"#1e293b",borderRadius:10,padding:24,color:"#64748b",textAlign:"center",fontSize:13}}>
          <strong style={{color:"#e2e8f0"}}>{res.q}</strong> 데이터 없음</div>
      )}
      {res && (res.refunds.length>0||res.responses.length>0) && (
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {/* 유저 요약 */}
          <div style={{background:"#1e293b",borderRadius:12,padding:16,borderLeft:"4px solid #6366f1"}}>
            <div style={{fontWeight:700,fontSize:14,marginBottom:10}}>👤 {res.q}</div>
            <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
              {[["환불건수",res.refunds.length+"건","#22d3ee"],
                ["총환불금액","₩"+res.refunds.reduce((s,d)=>s+(d.amount||0),0).toLocaleString(),"#ef4444"],
                ["대응내역",res.responses.length+"건","#f59e0b"],
                ["최종상태",res.responses.length?res.responses[res.responses.length-1].status:"-",
                  res.responses.length?(res.responses[res.responses.length-1].status==="복구완료"?"#22c55e":
                  res.responses[res.responses.length-1].status==="재제재"?"#ef4444":"#22d3ee"):"#64748b"],
              ].map(([l,v,c])=>(<div key={l} style={{background:"#0f172a",borderRadius:8,padding:"8px 14px"}}>
                <div style={{fontSize:10,color:"#64748b"}}>{l}</div>
                <div style={{fontSize:14,fontWeight:700,color:c,marginTop:2}}>{v}</div></div>))}
            </div>
          </div>

          {/* 환불 주문 내역 */}
          {res.refunds.length>0 && (
            <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
              <div style={{fontSize:13,color:"#94a3b8",marginBottom:12}}>💳 환불 주문 내역</div>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
                  <thead><tr style={{borderBottom:"1px solid #334155"}}>
                    {["환불일","주문번호","상품명","금액","플랫폼"].map(h=>(
                      <th key={h} style={{padding:"7px 10px",textAlign:"left",color:"#64748b",whiteSpace:"nowrap"}}>{h}</th>))}
                  </tr></thead>
                  <tbody>
                    {res.refunds.map((r,i)=>(
                      <tr key={i} style={{borderBottom:"1px solid #0f172a",background:i%2===0?"#0f172a":"transparent"}}>
                        <td style={{padding:"7px 10px",color:"#94a3b8",whiteSpace:"nowrap"}}>{r.date}</td>
                        <td style={{padding:"7px 10px",color:"#e2e8f0",fontSize:10}}>{r.orderNo||"-"}</td>
                        <td style={{padding:"7px 10px",color:"#e2e8f0"}}>{r.product||"-"}</td>
                        <td style={{padding:"7px 10px",color:"#ef4444",whiteSpace:"nowrap"}}>{"₩"+(r.amount||0).toLocaleString()}</td>
                        <td style={{padding:"7px 10px"}}><span style={{padding:"2px 7px",borderRadius:4,fontSize:10,
                          background:r.platform==="Google"?"#1e3a5f":"#3b1f5e",
                          color:r.platform==="Google"?"#4285F4":"#A855F7"}}>{r.platform}</span></td>
                      </tr>))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* 대응 타임라인 */}
          {res.responses.length>0 && (
            <div style={{background:"#1e293b",borderRadius:12,padding:16}}>
              <div style={{fontSize:13,color:"#94a3b8",marginBottom:16}}>📋 대응 타임라인</div>
              <div style={{display:"flex",flexDirection:"column",gap:0}}>
                {res.responses.map((r,i)=>{
                  const col = r.resanctioned?"#ef4444":r.status==="복구완료"?"#22c55e":"#22d3ee";
                  const icon = r.resanctioned?"🚫":r.status==="복구완료"?"✅":"⏳";
                  return (
                    <div key={i} style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                      <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                        <div style={{width:32,height:32,borderRadius:"50%",background:col+"22",border:`2px solid ${col}`,
                          display:"flex",alignItems:"center",justifyContent:"center",fontSize:12,flexShrink:0}}>
                          {icon}
                        </div>
                        {i<res.responses.length-1 && <div style={{width:2,height:40,background:"#334155"}}/>}
                      </div>
                      <div style={{paddingBottom:i<res.responses.length-1?12:0,flex:1}}>
                        <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                          <span style={{fontSize:12,fontWeight:600,color:"#e2e8f0"}}>{r.date}</span>
                          <span style={{padding:"2px 7px",borderRadius:4,fontSize:10,
                            background:r.resanctioned?"#450a0a":r.status==="복구완료"?"#14532d":"#164e63",
                            color:col}}>{r.status}</span>
                        </div>
                        <div style={{fontSize:11,color:"#94a3b8",lineHeight:1.6}}>
                          {r.cancelOrderNo && <div>주문번호: <span style={{color:"#e2e8f0"}}>{r.cancelOrderNo}</span></div>}
                          {r.cancelProduct && <div>상품: <span style={{color:"#e2e8f0"}}>{r.cancelProduct}</span></div>}
                          {r.releaseDate && <div>해제일시: <span style={{color:"#22d3ee"}}>{r.releaseDate}</span></div>}
                          {r.processDate && <div>처리날짜: <span style={{color:"#f59e0b"}}>{r.processDate}</span></div>}
                          {r.processResult && <div>처리결과: <span style={{color:col,fontWeight:600}}>{r.processResult}</span></div>}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
