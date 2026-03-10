import { useState, useMemo, useCallback, useEffect, useRef } from "react";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer, PieChart, Pie, Cell, LineChart, Line } from "recharts";
import * as XLSX from "xlsx";

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 상수
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const fmt = n => (n || 0).toLocaleString();
const TT = { contentStyle: { background: "#060d18", border: "1px solid #1e3a5f", borderRadius: 8, fontSize: 11 } };
const SHEET_ID = "1xySVvqx0DXiox8fkvMAr86WzP1hTdHzJuxf63iop6l8";
const TABS = ["마켓 환불 현황", "연도별 분석", "CS대응현황", "유저 조회", "AI 분석"];

// Google Play 전용 — 국가별 GID
const GSHEET_TARGETS = {
  한국: { label: "한국 AOS", gid: "0" },
  일본: { label: "일본 Google", gid: "1689075940" },
};

const CURRENCY_COUNTRY = { KRW: "한국", JPY: "일본" };
const STATUS_COLORS = { "복구완료": "#22c55e", "재제재": "#ef4444" };

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

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 엑셀 파싱 — Google AOS 전용
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function parseExcelFile(wb) {
  const orderRows = [];
  const abuseRows = [];
  const log = [];

  const getHeaders = (raw) => {
    let headerIdx = 0;
    for (let i = 0; i < Math.min(5, raw.length); i++) {
      const row = raw[i].map(c => String(c||"").toLowerCase());
      if (row.some(c =>
        c.includes("openid") || c.includes("오픈") || c.includes("open") ||
        c.includes("주문번호") || c.includes("order") || c.includes("화폐") ||
        c.includes("currency")
      )) { headerIdx = i; break; }
    }
    return { headerIdx, headers: raw[headerIdx].map(c => String(c||"").trim()) };
  };

  const findCol = (headers, ...names) => {
    for (const n of names) {
      const idx = headers.findIndex(h => new RegExp(n, "i").test(h));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  wb.SheetNames.forEach(sName => {
    const ws = wb.Sheets[sName];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: "", header: 1 });
    console.log("[시트감지]", sName, "행수:", raw?.length);
    if (!raw || raw.length < 2) return;

    const sLower = sName.toLowerCase();
    const { headerIdx, headers } = getHeaders(raw);
    const fc = (...n) => findCol(headers, ...n);

    // ━━━ 시트1: 악용 대상자 UC 보유 정보 ━━━
    const isUCSheet = sName === "악용 대상자 UC 보유 정보" ||
      sLower.includes("uc 보유") || sLower.includes("uc보유") ||
      sLower.includes("보유 정보") || sLower.includes("보유정보") ||
      sLower.includes("악용 대상자 uc") || sLower.includes("악용대상자uc") ||
      sLower.includes("대상자 uc") || sLower.includes("uc 보유 정보") ||
      (sLower.includes("대상자") && sLower.includes("보유"));
    if (isUCSheet) {
      const ci = {
        openid: fc("오픈 아이디","오픈아이디","openid","open id","open_id","오픈 id","오픈id"),
        orderNo: fc("주문번호","order number","order no","orderid"),
        currency: (() => {
          const idx = fc("화폐","currency","통화","h열","화폐종류");
          return idx >= 0 ? idx : 7; // H열 기본값
        })(),
        ucBalance: fc("uc잔액","uc 잔액","잔액","현재 보유","현재보유"),
        time: fc("시간","time","날짜","date","기간"),
        amount: fc("charged amount","item price","payamt","금액","amount"),
      };
      let parsed = 0;
      for (let i = headerIdx + 1; i < raw.length; i++) {
        const row = raw[i];
        const openid = String(row[ci.openid] ?? "").trim();
        const orderNo = String(row[ci.orderNo] ?? "").trim();
        if (!openid && !orderNo) continue;
        const currency = String(row[ci.currency] ?? "KRW").trim().toUpperCase() || "KRW";
        const country = getCountry(currency);
        // 기타 국가(KRW/JPY 아닌 경우) 제외
        if (country === "기타") continue;
        const dateRaw = ci.time >= 0 ? row[ci.time] : "";
        const date = parseDate(String(dateRaw||"")) || "";
        const amount = Math.abs(parseNum(ci.amount >= 0 ? row[ci.amount] : 0));
        orderRows.push({
          orderNo, openid, currency, country, platform: "Google", // Google AOS 전용
          date, year: date.slice(0,4), month: date.slice(0,7),
          ucBalance: parseNum(ci.ucBalance >= 0 ? row[ci.ucBalance] : 0),
          amount, type: "UC보유정보",
        });
        parsed++;
      }
      log.push({ sheet: sName, type: "UC보유정보", count: parsed });
    }

    // ━━━ 시트1b: OrderID 시트 ━━━
    else if (sLower.includes("orderid") || sLower.includes("악용 대상자 order") || sLower.includes("대상자 orderid")) {
      const ci = {
        orderNo: fc("order number","주문번호","orderid","order no"),
        openid: fc("오픈 아이디","openid","open id","오픈아이디"),
        currency: fc("currency of sale","화폐","currency","currencytype"),
        amount: fc("charged amount","item price","payamt","금액"),
        time: fc("order charged date","orderdate","시간","date","날짜","ordertime"),
      };
      let parsed = 0;
      for (let i = headerIdx + 1; i < raw.length; i++) {
        const row = raw[i];
        const orderNo = String(row[ci.orderNo] ?? "").trim();
        if (!orderNo || !orderNo.toUpperCase().startsWith("GPA")) continue;
        const amount = Math.abs(parseNum(ci.amount >= 0 ? row[ci.amount] : 0));
        const existing = orderRows.find(o => o.orderNo === orderNo);
        if (existing) {
          if (amount > 0) existing.amount = amount;
        } else {
          const openid = String(row[ci.openid] ?? "").trim();
          const currency = String(row[ci.currency] ?? "KRW").trim().toUpperCase() || "KRW";
          const country = getCountry(currency);
          const dateRaw = ci.time >= 0 ? row[ci.time] : "";
          const date = parseDate(String(dateRaw||"")) || "";
          orderRows.push({
            orderNo, openid, currency, country, platform: "Google",
            date, year: date.slice(0,4), month: date.slice(0,7),
            ucBalance: 0, amount, type: "OrderID", // 카운트 제외
          });
          parsed++;
        }
      }
      log.push({ sheet: sName, type: "OrderID(Google)", count: parsed });
    }

    // ━━━ 시트2: 악용자 리스트 ━━━
    else if (sLower.includes("악용자 리스트") || sLower.includes("악용자리스트") ||
             (sLower.includes("악용자") && sLower.includes("리스트")) ||
             sLower.includes("결제취소 악용자")) {
      const ci = {
        currency: fc("화폐","currency") >= 0 ? fc("화폐","currency") : 0,
        openid: fc("openid","오픈","open id","open_id") >= 0 ? fc("openid","오픈","open id","open_id") : 1,
        abuseCount: fc("악용 횟수","악용횟수","횟수"),
        totalUC: fc("누적 획득","누적획득","누적"),
        currentUC: fc("현재 보유","현재보유","현재"),
        pValue: fc("p값","p 값"),
        result: fc("회수","제재","처리결과","결과","처리") >= 0 ? fc("회수","제재","처리결과","결과","처리") : 6,
      };
      // 유니크 OpenID만 저장 (중복 제거)
      const abuseOidSet = new Set();
      let parsed = 0;
      for (let i = headerIdx + 1; i < raw.length; i++) {
        const row = raw[i];
        const openid = String(row[ci.openid] ?? "").trim();
        if (!openid) continue;
        if (abuseOidSet.has(openid)) continue; // 중복 제거
        abuseOidSet.add(openid);
        const currency = String(row[ci.currency] ?? "KRW").trim().toUpperCase() || "KRW";
        const country = getCountry(currency);
        if (country === "기타") continue; // KRW/JPY 아닌 경우 제외
        const resultText = String(row[ci.result] ?? "").trim();
        const hasJesae = /제재/.test(resultText);
        const hasHoesu = /회수/.test(resultText);
        let action = "미처리";
        if (hasJesae && hasHoesu) action = "제재+회수";
        else if (hasJesae) action = "제재";
        else if (hasHoesu) action = "회수";
        else if (/uc부족|uc 부족|부족/.test(resultText.toLowerCase())) action = "제재";
        abuseRows.push({
          openid, currency, country, platform: "Google",
          abuseCount: parseNum(row[ci.abuseCount]),
          totalUC: parseNum(row[ci.totalUC]),
          currentUC: parseNum(row[ci.currentUC]),
          pValue: parseNum(ci.pValue >= 0 ? row[ci.pValue] : 0),
          resultText, action,
        });
        parsed++;
      }
      log.push({ sheet: sName, type: "악용자", count: parsed });
    }
    // iOS/Apple 시트 무시
  });

  const oidInfo = {};
  orderRows.forEach(o => {
    if (o.openid && !oidInfo[o.openid]) oidInfo[o.openid] = { country: o.country, currency: o.currency };
  });
  const abuseMap = {};
  abuseRows.forEach(a => { if (a.openid) abuseMap[a.openid] = a; });

  return { orderRows, abuseRows, abuseMap, oidInfo, log };
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

function parseGSheetCSV(text, country) {
  const allRows = parseCSV(text);
  if (allRows.length < 3) return [];
  let headerIdx = 0;
  for (let i = 0; i < Math.min(8, allRows.length); i++) {
    if (allRows[i].some(c => /openid|open.id|オープン|캐릭|キャラ/i.test(c||""))) { headerIdx = i; break; }
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
  let resultIdx = headers.length - 1;
  for (let c = headers.length - 1; c >= 0; c--) { if (headers[c]&&headers[c].trim()) { resultIdx=c; break; } }
  const isJapan = country === "일본";
  let japanCommentIdx = 24;
  for (let c = 0; c < headers.length; c++) {
    if (/コメント|comment|対応内容|履歴|history/i.test(headers[c]||"")) { japanCommentIdx=c; break; }
  }
  const get = (row, idx) => (idx >= 0 && idx < row.length) ? (row[idx]||"").trim() : "";
  const classifyStatus = (row) => {
    if (isJapan) {
      const commentCell = get(row, japanCommentIdx);
      const lines = commentCell.split(/\n|\r/).map(l=>l.trim()).filter(Boolean);
      const lastLine = lines[lines.length-1]||"";
      if (/回収完了|解除完了|回収いたしました|UCの回収|案内済み|対応完了|チャージ完了|복구완료|회수완료/.test(lastLine)) return "복구완료";
      if (/回収完了|解除完了|回収いたしました|UCの回収|案内済み|対応完了/.test(commentCell)&&!/ヒアリング中|希望日/.test(lastLine)) return "복구완료";
      if (/BANいたしました|BAN処理|期限が過ぎたためBAN|再度BAN|停止いたしました/.test(lastLine)) return "재제재";
      if (/BANいたしました|BAN処理いたしました|期限が過ぎたためBAN/.test(commentCell)&&!/案内/.test(lastLine)) return "재제재";
      return "처리중";
    } else {
      const resultText = get(row, resultIdx);
      if (!resultText||resultText==="-") return "처리중";
      if (/회수|해제|복구|완료|정상화|재충전|回収|解除/.test(resultText)) return "복구완료";
      if (/제재|정지|ban|밴|BAN|않음|미결제/.test(resultText)) return "재제재";
      return "처리중";
    }
  };
  const results = [];
  for (let i = headerIdx+1; i < allRows.length; i++) {
    const row = allRows[i];
    if (!row||row.every(c=>!c||c.trim()==="")) continue;
    const openid = get(row, ci.openid);
    if (!openid) continue;
    const resultText = isJapan ? get(row, japanCommentIdx) : get(row, resultIdx);
    const status = classifyStatus(row);
    const dateRaw = get(row, ci.date);
    const date = parseDate(dateRaw)||dateRaw.slice(0,10)||"";
    results.push({
      openid, country, platform:"Google",
      date, year:date.slice(0,4), month:date.slice(0,7),
      abuseCount:parseNum(get(row,ci.abuseCount)),
      totalUC:parseNum(get(row,ci.totalUC)),
      currentUC:parseNum(get(row,ci.currentUC)),
      amount:Math.abs(parseNum(get(row,ci.amount))),
      resultText, status,
    });
  }
  return results;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Card 컴포넌트
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ━━━ 호버 툴팁 컴포넌트 ━━━
function HoverTooltip({ children, lines, maxH=320 }) {
  const [pos, setPos] = useState(null);
  const handleEnter = (e) => setPos({ x: e.clientX, y: e.clientY });
  const handleMove  = (e) => setPos({ x: e.clientX, y: e.clientY });
  const handleLeave = ()  => setPos(null);
  const tipW = 360;
  const tipLeft = pos ? Math.min(pos.x + 14, window.innerWidth - tipW - 10) : 0;
  const tipTop  = pos ? (pos.y + 14 + maxH > window.innerHeight ? pos.y - maxH - 8 : pos.y + 14) : 0;
  return (
    <span style={{position:"relative",cursor:"help"}}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
      onMouseMove={handleMove}>
      {children}
      {pos && lines && lines.length > 0 && (
        <div style={{
          position:"fixed", zIndex:99999,
          left: tipLeft, top: tipTop,
          background:"#060d18", border:"1px solid #3b82f666",
          borderRadius:10, padding:"10px 14px", width:tipW,
          boxShadow:"0 8px 32px rgba(0,0,0,0.8)", pointerEvents:"none",
          maxHeight: maxH, overflowY:"auto",
        }}>
          {lines.map((line,i)=>(
            <div key={i} style={{
              fontSize:10,
              borderBottom: i<lines.length-1?"1px solid #1e3a5f33":"none",
              padding:"4px 0",
              display:"flex", justifyContent:"space-between", gap:12,
            }}>
              <span style={{color:"#4a6fa5",flexShrink:0,fontFamily:line.mono?"monospace":"inherit"}}>{line.label}</span>
              <span style={{color:line.color||"#c8d8f0",wordBreak:"break-all",textAlign:"right",fontFamily:line.mono?"monospace":"inherit"}}>{line.value}</span>
            </div>
          ))}
        </div>
      )}
    </span>
  );
}

const Card = ({ icon, label, value, sub, color="#3b82f6" }) => (
  <div style={{ background:"linear-gradient(135deg,#0d1b2e,#0a1220)", borderRadius:14, padding:"16px 18px", border:`1px solid ${color}33`, borderLeft:`4px solid ${color}`, position:"relative", overflow:"hidden" }}>
    <div style={{ position:"absolute", top:-10, right:-10, width:70, height:70, background:`radial-gradient(circle,${color}18,transparent 70%)`, borderRadius:"50%" }}/>
    <div style={{ fontSize:10, color:"#2d4a6e", marginBottom:5, textTransform:"uppercase", letterSpacing:"0.06em" }}>{icon} {label}</div>
    <div style={{ fontSize:24, fontWeight:800, color, lineHeight:1 }}>{value}</div>
    {sub && <div style={{ fontSize:10, color:"#2d4a6e", marginTop:5 }}>{sub}</div>}
  </div>
);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 랜딩 페이지
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function LandingPage({ onEnter, parsedData, uploadLog, onFile, fileNames }) {
  const hasData = parsedData !== null;
  return (
    <div style={{ fontFamily:"'Pretendard','Apple SD Gothic Neo',sans-serif", background:"#060d18", minHeight:"100vh", color:"#c8d8f0", display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", padding:"40px 20px", position:"relative", overflow:"hidden" }}>
      <div style={{ position:"absolute", inset:0, backgroundImage:"linear-gradient(#1e3a5f18 1px,transparent 1px),linear-gradient(90deg,#1e3a5f18 1px,transparent 1px)", backgroundSize:"40px 40px", pointerEvents:"none" }}/>
      <div style={{ position:"absolute", inset:0, background:"radial-gradient(ellipse 50% 40% at 30% 50%,#0ea5e912,transparent 60%),radial-gradient(ellipse 50% 40% at 70% 50%,#f9731612,transparent 60%)", pointerEvents:"none" }}/>

      <div style={{ textAlign:"center", marginBottom:48, position:"relative", zIndex:1 }}>
        <div style={{ display:"inline-flex", alignItems:"center", gap:8, padding:"5px 16px", borderRadius:20, border:"1px solid #1e3a5f", background:"#0d1b2e", fontSize:11, color:"#2d4a6e", letterSpacing:"0.1em", textTransform:"uppercase", marginBottom:20 }}>
          🎮 PUBG MOBILE · CS OPS TOOL · GOOGLE PLAY
        </div>
        <h1 style={{ fontSize:"clamp(26px,5vw,44px)", fontWeight:900, lineHeight:1.1, letterSpacing:"-0.03em", color:"#e8f4ff", margin:"0 0 10px" }}>
          결제취소 악용자<br/>
          <span style={{ background:"linear-gradient(135deg,#3b82f6,#60a5fa)", WebkitBackgroundClip:"text", WebkitTextFillColor:"transparent" }}>대응현황 대시보드</span>
        </h1>
        <p style={{ color:"#2d4a6e", fontSize:13 }}>🤖 Google Play 전용 · 파일 업로드 후 국가를 선택하세요</p>
      </div>

      {/* 파일 업로드 */}
      <div style={{ width:"100%", maxWidth:600, marginBottom:36, position:"relative", zIndex:1 }}>
        <div style={{ background:"#0d1b2e", borderRadius:16, padding:20, border:"1px solid #1e3a5f" }}>
          <div style={{ fontSize:13, fontWeight:700, color:"#c8d8f0", marginBottom:4 }}>📁 엑셀 파일 업로드</div>
          <div style={{ fontSize:11, color:"#2d4a6e", marginBottom:14 }}>한국 + 일본 데이터가 포함된 파일을 <strong style={{color:"#4a6fa5"}}>한 번만</strong> 업로드하세요</div>
          {fileNames.length > 0 && (
            <div style={{ marginBottom:12, display:"flex", gap:8, flexWrap:"wrap" }}>
              {fileNames.map((name,i) => (
                <div key={i} style={{ background:"#060d18", borderRadius:8, padding:"6px 12px", border:"1px solid #22c55e44" }}>
                  <span style={{ fontSize:11, color:"#22c55e" }}>✅ {name}</span>
                </div>
              ))}
            </div>
          )}
          <div
            onClick={()=>{ const inp=document.createElement("input"); inp.type="file"; inp.accept=".xlsx,.xls"; inp.multiple=true; inp.onchange=e=>[...e.target.files].forEach(onFile); inp.click(); }}
            onDrop={e=>{ e.preventDefault(); [...e.dataTransfer.files].forEach(onFile); }}
            onDragOver={e=>e.preventDefault()}
            style={{ border:"2px dashed #1e3a5f", borderRadius:10, padding:"20px", textAlign:"center", cursor:"pointer", transition:"all 0.2s" }}
            onMouseEnter={e=>e.currentTarget.style.borderColor="#3b82f6"}
            onMouseLeave={e=>e.currentTarget.style.borderColor="#1e3a5f"}
          >
            <div style={{ fontSize:28, marginBottom:6 }}>📂</div>
            <div style={{ fontSize:13, color:"#4a6fa5", fontWeight:600 }}>클릭 또는 드래그하여 업로드</div>
            <div style={{ fontSize:11, color:"#1e3a5f", marginTop:4 }}>Google AOS 데이터 포함 파일</div>
          </div>
          {uploadLog.length > 0 && (
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:10 }}>
              {uploadLog.map((l,i) => (
                <span key={i} style={{ fontSize:10, padding:"3px 8px", borderRadius:4, background:"#14532d", color:"#22c55e" }}>✅ {l.sheet} ({l.type}: {l.count}건)</span>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 국가 카드 */}
      <div style={{ display:"flex", gap:20, flexWrap:"wrap", justifyContent:"center", position:"relative", zIndex:1 }}>
        {[
          { key:"한국", flag:"🇰🇷", title:"한국 대시보드", desc:"Google Play · KRW 기준", color:"#0ea5e9", bgFrom:"#0a1e3a" },
          { key:"일본", flag:"🇯🇵", title:"日本ダッシュボード", desc:"Google Play · JPY 기준", color:"#f97316", bgFrom:"#1a100a" },
        ].map(card => (
          <div key={card.key}
            onClick={() => hasData && onEnter(card.key)}
            style={{ width:260, borderRadius:20, padding:"28px 24px", cursor:hasData?"pointer":"not-allowed", background:`linear-gradient(145deg,${card.bgFrom},#0d1b2e)`, border:`1px solid ${hasData?card.color+"55":"#1e3a5f"}`, boxShadow:hasData?`0 0 30px ${card.color}12`:"none", opacity:hasData?1:0.4, transition:"all 0.3s ease", position:"relative", overflow:"hidden" }}
            onMouseEnter={e=>{ if(hasData){e.currentTarget.style.transform="translateY(-6px)";e.currentTarget.style.boxShadow=`0 16px 40px ${card.color}28`;}}}
            onMouseLeave={e=>{ e.currentTarget.style.transform="translateY(0)";e.currentTarget.style.boxShadow=hasData?`0 0 30px ${card.color}12`:"none"; }}
          >
            <div style={{ position:"absolute", top:-30, right:-30, width:120, height:120, borderRadius:"50%", background:`radial-gradient(circle,${card.color}18,transparent 70%)`, pointerEvents:"none" }}/>
            <div style={{ fontSize:44, marginBottom:12 }}>{card.flag}</div>
            <div style={{ fontSize:18, fontWeight:900, color:card.color, marginBottom:6 }}>{card.title}</div>
            <div style={{ fontSize:11, color:"#2d4a6e", marginBottom:20 }}>🤖 {card.desc}</div>
            <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", paddingTop:14, borderTop:"1px solid #ffffff0f", fontSize:12, fontWeight:700, color:card.color }}>
              <span>{hasData?"대시보드 입장":"파일을 먼저 업로드하세요"}</span>
              {hasData && <span style={{fontSize:16}}>→</span>}
            </div>
          </div>
        ))}
      </div>
      {!hasData && <div style={{ marginTop:20, fontSize:12, color:"#1e3a5f", position:"relative", zIndex:1 }}>⬆️ 파일을 업로드하면 국가 선택이 활성화됩니다</div>}
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 대시보드 (Google Play 전용)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
function Dashboard({ country, parsedData, onBack }) {
  const [tab, setTab] = useState("마켓 환불 현황");
  const [yearFilter, setYearFilter] = useState("전체");
  const [monthFilter, setMonthFilter] = useState("전체");
  const [csStatusTab, setCsStatusTab] = useState("");
  const [expandedYear, setExpandedYear] = useState(null);
  const [responseData, setResponseData] = useState([]);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [sheetErr, setSheetErr] = useState("");
  const [sheetStatus, setSheetStatus] = useState(null);
  const [lastFetch, setLastFetch] = useState("");
  const [chatMessages, setChatMessages] = useState([{ role:"assistant", content:`안녕하세요! ${country} Google Play 결제취소 악용자 대응현황을 분석해드립니다 😊\n\n예시 질문:\n• 2025년 주문건수 몇 건이에요?\n• 제재된 사람 몇 명이에요?\n• 복구 완료율이 어떻게 돼요?` }]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const chatEndRef = useRef(null);
  const [searchQ, setSearchQ] = useState("");
  const [searchRes, setSearchRes] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (msg, color="#22c55e") => { setToast({msg,color}); setTimeout(()=>setToast(null),3000); };
  // OpenID 정규화 함수 (과학적 표기법, 소수점 처리)
  const normalizeOid = (oid) => {
    if (!oid) return "";
    let s = String(oid).trim();
    if (/e[+\-]/i.test(s)) {
      try { s = String(Math.round(parseFloat(s))); } catch(ex) {}
    }
    return s.replace(/\.0+$/, "");
  };

  const countryColor = country==="한국"?"#0ea5e9":"#f97316";
  const countryFlag = country==="한국"?"🇰🇷":"🇯🇵";
  const currencySymbol = country==="한국"?"₩":"¥";
  const currencyCode = country==="한국"?"KRW":"JPY";

  // 국가 + Google 필터
  const allOrderRows = useMemo(() =>
    parsedData.orderRows.filter(d => d.country===country && d.platform==="Google"),
  [parsedData, country]);

  const allAbuseRows = useMemo(() =>
    parsedData.abuseRows.filter(d => d.country===country),
  [parsedData, country]);

  const allAbuseMap = useMemo(() => {
    const map = {};
    parsedData.abuseRows.filter(a=>a.country===country).forEach(a=>{
      if(a.openid) map[normalizeOid(a.openid)]=a;
    });
    return map;
  }, [parsedData, country]);

  const years = useMemo(() => {
    const ys = [...new Set(allOrderRows.map(d=>d.year))].filter(Boolean).sort();
    return ["전체",...ys];
  }, [allOrderRows]);

  const months = useMemo(() => {
    const src = yearFilter==="전체" ? allOrderRows : allOrderRows.filter(d=>d.year===yearFilter);
    const ms = [...new Set(src.map(d=>d.month))].filter(Boolean).sort();
    return ["전체",...ms];
  }, [allOrderRows, yearFilter]);

  const filtered = useMemo(() => allOrderRows.filter(d => {
    if (yearFilter!=="전체"&&d.year!==yearFilter) return false;
    if (monthFilter!=="전체"&&d.month!==monthFilter) return false;
    return true;
  }), [allOrderRows, yearFilter, monthFilter]);

  const fetchSheets = useCallback(async () => {
    setSheetLoading(true); setSheetErr(""); setSheetStatus(null);
    try {
      const res = await fetch("/api/sheets?country="+encodeURIComponent(country));
      const data = await res.json();
      if (data.success && data.data.length>0) {
        setResponseData(data.data);
        setLastFetch(new Date().toLocaleTimeString());
        setSheetStatus({ label:GSHEET_TARGETS[country]?.label, count:data.data.length, ok:true });
      } else {
        setSheetErr(data.error||"데이터를 불러오지 못했어요.");
        setSheetStatus({ ok:false });
      }
    } catch(e) { setSheetErr("API 오류: "+e.message); }
    setSheetLoading(false);
  }, [country]);

  const filteredResp = useMemo(() => responseData.filter(d => {
    if (yearFilter!=="전체"&&d.year!==yearFilter) return false;
    if (monthFilter!=="전체"&&d.month!==monthFilter) return false;
    return true;
  }), [responseData, yearFilter, monthFilter]);



  const sheetOidMap = useMemo(() => {
    const map = {};
    [...responseData]
      .filter(d => d.status === "복구완료" || d.status === "재제재")
      .sort((a,b) => a.date.localeCompare(b.date))
      .forEach(d => {
        if (!d.openid) return;
        const key = normalizeOid(d.openid);
        const val = { status: d.status, lastDate: d.date };
        if (!map[key] || d.date >= map[key].lastDate) map[key] = val;
        // truncatedOid도 키로 등록 (일본 OpenID 정밀도 손실 대응)
        if (d.truncatedOid && !map[d.truncatedOid]) map[d.truncatedOid] = val;
      });
    return map;
  }, [responseData]);

  const stats = useMemo(() => {
    const totalOrders = filtered.filter(d=>d.type==="UC보유정보").length;
    const uniqueUsers = new Set(filtered.filter(d=>d.type==="UC보유정보").map(d=>d.openid).filter(Boolean)).size;
    // 환불 금액: UC보유정보 시트 기준 (OrderID 시트로 금액 업데이트됨)
    const amountTotal = filtered.reduce((s,d)=>s+Math.abs(d.amount||0),0);

    const abuseUniqueOids = [...new Set(allAbuseRows.map(a=>normalizeOid(a.openid)).filter(Boolean))];
    const totalAbuseUnique = abuseUniqueOids.length;
    let sanctioned=0, recovered=0;
    abuseUniqueOids.forEach(oid=>{
      const a=allAbuseMap[oid]; if(!a) return;
      if(a.action==="제재"||a.action==="제재+회수") sanctioned++;
      if(a.action==="회수"||a.action==="제재+회수") recovered++;
    });
    let respRecovered=0, respResanctioned=0;
    abuseUniqueOids.forEach(oid=>{
      const sv=sheetOidMap[normalizeOid(oid)];
      if(!sv) return;
      if(sv.status==="복구완료") respRecovered++;
      else if(sv.status==="재제재") respResanctioned++;
    });
    return { totalOrders, amountTotal, totalAbuseUnique, sanctioned, recovered, respRecovered, respResanctioned };
  }, [filtered, allAbuseRows, allAbuseMap, sheetOidMap]);

  const yearlyChart = useMemo(() => {
    const g = {};
    allOrderRows.filter(d=>d.type==="UC보유정보").forEach(d=>{
      if(!d.year) return;
      if(!g[d.year]) g[d.year]={year:d.year,주문건수:0};
      g[d.year].주문건수++;
    });
    return Object.values(g).sort((a,b)=>a.year.localeCompare(b.year));
  }, [allOrderRows]);

  // OrderID 시트 rows를 orderNo 기준으로 빠르게 조회하기 위한 맵
  const orderIdAmountMap = useMemo(() => {
    const map = {};
    allOrderRows.filter(d=>d.type==="OrderID"&&d.orderNo).forEach(d=>{
      map[d.orderNo] = Math.abs(d.amount||0);
    });
    return map;
  }, [allOrderRows]);

  const yearlyAbuseStats = useMemo(() => {
    const g = {};
    allAbuseRows.forEach(a=>{
      const normOid = normalizeOid(a.openid);
      const uc = allOrderRows.find(d=>normalizeOid(d.openid)===normOid&&d.type==="UC보유정보");
      const year = uc?.year; if(!year) return;
      if(!g[year]) g[year]={sanctioned:0,recovered:0,resanctioned:0,recoveredAmount:0,recoveredOids:[],recoveredOrders:[]};
      if(a.action==="제재"||a.action==="제재+회수") g[year].sanctioned++;
      const svKey = sheetOidMap[normOid] ? normOid : (normOid.length>15 ? normOid.slice(0,15) : null);
      const sv = svKey ? sheetOidMap[svKey] : null;
      if(sv?.status==="복구완료") {
        g[year].recovered++;
        g[year].recoveredOids.push(a.openid); // 툴팁용 OpenID 저장
        const ucRows = allOrderRows.filter(d=>normalizeOid(d.openid)===normOid&&d.type==="UC보유정보");
        const amt = ucRows.reduce((s,d)=>{
          const orderAmt = d.orderNo ? (orderIdAmountMap[d.orderNo]||0) : 0;
          const finalAmt = orderAmt > 0 ? orderAmt : Math.abs(d.amount||0);
          if(d.orderNo) g[year].recoveredOrders.push({ // 툴팁용 주문 저장
            openid: a.openid, orderNo: d.orderNo, amount: finalAmt
          });
          return s + finalAmt;
        }, 0);
        g[year].recoveredAmount += amt;
      } else if(sv?.status==="재제재") g[year].resanctioned++;
    });
    return g;
  }, [allAbuseRows, allOrderRows, sheetOidMap, orderIdAmountMap]);

  // 연도별 분석 - 월별 상세 데이터
  const monthlyStats = useMemo(() => {
    const g = {};
    // UC보유정보 주문 집계
    allOrderRows.filter(d=>d.type==="UC보유정보").forEach(d=>{
      if(!d.year||!d.month) return;
      if(!g[d.year]) g[d.year]={};
      if(!g[d.year][d.month]) g[d.year][d.month]={month:d.month,orders:0,amount:0,sanctioned:0,recovered:0,resanctioned:0,recoveredAmount:0,recoveredOids:[],recoveredOrders:[]};
      g[d.year][d.month].orders++;
      g[d.year][d.month].amount += Math.abs(d.amount||0);
    });
    // OrderID 금액 합산
    allOrderRows.filter(d=>d.type==="OrderID").forEach(d=>{
      if(!d.year||!d.month) return;
      if(!g[d.year]) g[d.year]={};
      if(!g[d.year][d.month]) g[d.year][d.month]={month:d.month,orders:0,amount:0,sanctioned:0,recovered:0,resanctioned:0,recoveredAmount:0,recoveredOids:[],recoveredOrders:[]};
      g[d.year][d.month].amount += Math.abs(d.amount||0);
    });
    // 악용자 리스트 제재/복구 집계 (월별)
    allAbuseRows.forEach(a=>{
      const normOid = normalizeOid(a.openid);
      const ucRow = allOrderRows.find(d=>normalizeOid(d.openid)===normOid&&d.type==="UC보유정보");
      if(!ucRow?.year||!ucRow?.month) return;
      const yr=ucRow.year, mo=ucRow.month;
      if(!g[yr]) g[yr]={};
      if(!g[yr][mo]) g[yr][mo]={month:mo,orders:0,amount:0,sanctioned:0,recovered:0,resanctioned:0,recoveredAmount:0,recoveredOids:[],recoveredOrders:[]};
      if(a.action==="제재"||a.action==="제재+회수") g[yr][mo].sanctioned++;
      // lookupOid 직접 구현 (선언 순서 문제 회피)
      const svKey = sheetOidMap[normOid] ? normOid : (normOid.length>15 ? normOid.slice(0,15) : null);
      const sv = svKey ? sheetOidMap[svKey] : null;
      if(sv?.status==="복구완료") {
        g[yr][mo].recovered++;
        g[yr][mo].recoveredOids.push(a.openid);
        // 복구된 OpenID의 UC보유정보 주문번호 → OrderID 시트 금액 합산 (없으면 UC amount 폴백)
        const ucRows = allOrderRows.filter(d=>normalizeOid(d.openid)===normOid&&d.type==="UC보유정보");
        g[yr][mo].recoveredAmount += ucRows.reduce((s,d)=>{
          const orderAmt = d.orderNo ? (orderIdAmountMap[d.orderNo]||0) : 0;
          const finalAmt = orderAmt > 0 ? orderAmt : Math.abs(d.amount||0);
          if(d.orderNo) g[yr][mo].recoveredOrders.push({openid:a.openid, orderNo:d.orderNo, amount:finalAmt});
          return s + finalAmt;
        }, 0);
      } else if(sv?.status==="재제재") g[yr][mo].resanctioned++;
    });
    const result = {};
    Object.keys(g).forEach(year => {
      result[year] = Object.values(g[year]).sort((a,b)=>a.month.localeCompare(b.month));
    });
    return result;
  }, [allOrderRows, allAbuseRows, sheetOidMap, orderIdAmountMap]);

  const monthlyChart = useMemo(() => {
    const src = yearFilter==="전체"?allOrderRows:filtered;
    const g = {};
    src.filter(d=>d.type==="UC보유정보").forEach(d=>{
      if(!d.month) return;
      if(!g[d.month]) g[d.month]={month:d.month,주문건수:0};
      g[d.month].주문건수++;
    });
    return Object.values(g).sort((a,b)=>a.month.localeCompare(b.month));
  }, [allOrderRows, filtered, yearFilter]);

  const respTrend = useMemo(() => {
    const g = {};
    filteredResp.forEach(d=>{
      const k=d.month||d.year; if(!k) return;
      if(!g[k]) g[k]={month:k,복구완료:0,재제재:0};
      if(d.status==="복구완료"||d.status==="재제재") g[k][d.status]++;
    });
    return Object.values(g).sort((a,b)=>a.month.localeCompare(b.month));
  }, [filteredResp]);

  const sendChat = useCallback(async () => {
    const msg=chatInput.trim(); if(!msg||chatLoading) return;
    setChatInput(""); setChatMessages(prev=>[...prev,{role:"user",content:msg}]); setChatLoading(true);
    const ctx = { 국가:country, 플랫폼:"Google Play", 전체주문건수:allOrderRows.length, 유니크유저:stats.uniqueUsers, 환불금액:stats.amountTotal, 악용자:{유니크OpenID:stats.totalAbuseUnique,회수:stats.recovered,제재:stats.sanctioned}, 대응현황:{복구완료:stats.respRecovered,재제재:stats.respResanctioned}, 연도별:Object.fromEntries(yearlyChart.map(d=>[d.year+"년",d.주문건수])) };
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:"claude-sonnet-4-20250514",max_tokens:1000,system:`당신은 PUBG Mobile 결제취소 악용자 대응 데이터 분석 어시스턴트입니다.\n현재 대시보드: ${country} Google Play 전용\n데이터: ${JSON.stringify(ctx,null,2)}\n한국어로 간결하게 답변해주세요.`,messages:[...chatMessages.slice(1),{role:"user",content:msg}]})});
      const data=await res.json();
      setChatMessages(prev=>[...prev,{role:"assistant",content:data.content?.[0]?.text||"응답 오류"}]);
    } catch(e) { setChatMessages(prev=>[...prev,{role:"assistant",content:"오류: "+e.message}]); }
    setChatLoading(false);
  }, [chatInput,chatLoading,chatMessages,country,allOrderRows,stats,yearlyChart]);

  useEffect(()=>{ chatEndRef.current?.scrollIntoView({behavior:"smooth"}); },[chatMessages]);

  const doSearch = useCallback(() => {
    const q=searchQ.trim(); if(!q) return;
    let searchOids=new Set();
    allOrderRows.forEach(d=>{if(d.openid&&(d.openid.includes(q)||(d.orderNo&&d.orderNo.includes(q))))searchOids.add(d.openid);});
    responseData.forEach(d=>{if(d.openid&&d.openid.includes(q))searchOids.add(d.openid);});
    if(searchOids.size===0) searchOids.add(q);
    const oids=[...searchOids];
    const orders=allOrderRows.filter(d=>oids.some(oid=>d.openid===oid)).sort((a,b)=>a.date.localeCompare(b.date));
    const abuse=allAbuseRows.find(a=>oids.some(oid=>a.openid===oid));
    const history=responseData.filter(d=>oids.some(oid=>d.openid===oid)).sort((a,b)=>a.date.localeCompare(b.date));
    const latestStatus=sheetOidMap[oids[0]]||null;
    const yearSummary={};
    orders.forEach(o=>{if(!yearSummary[o.year])yearSummary[o.year]={count:0};yearSummary[o.year].count++;});
    setSearchRes({q,orders,abuse,history,latestStatus,yearSummary});
  }, [searchQ,allOrderRows,allAbuseRows,responseData,sheetOidMap]);

  const hasData = allOrderRows.length>0;
  const hasResp = responseData.length>0;

  const FilterBar = () => (
    <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap",alignItems:"center"}}>
      <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
        {years.map(y=>(
          <button key={y} onClick={()=>{setYearFilter(y);setMonthFilter("전체");}}
            style={{padding:"4px 12px",borderRadius:20,border:`1px solid ${yearFilter===y?countryColor:"#1e3a5f"}`,fontSize:11,fontWeight:600,cursor:"pointer",background:yearFilter===y?countryColor:"#0d1b2e",color:yearFilter===y?"#fff":"#4a6fa5"}}>
            {y}
          </button>
        ))}
      </div>
      {months.length>2&&(
        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
          {months.map(m=>(
            <button key={m} onClick={()=>setMonthFilter(m)}
              style={{padding:"3px 10px",borderRadius:20,border:`1px solid ${monthFilter===m?"#0891b2":"#1e3a5f"}`,fontSize:10,fontWeight:600,cursor:"pointer",background:monthFilter===m?"#0891b2":"#0d1b2e",color:monthFilter===m?"#fff":"#4a6fa5"}}>
              {m==="전체"?"전체월":m}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const SheetBox = () => (
    <div style={{background:"#0d1b2e",borderRadius:14,padding:16,marginBottom:16,border:"1px solid #1e3a5f"}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div>
          <div style={{fontSize:13,fontWeight:700,color:"#c8d8f0"}}>🔗 Google Sheets 실시간 연동 ({country})</div>
          <div style={{fontSize:11,color:"#2d4a6e",marginTop:2}}>{GSHEET_TARGETS[country]?.label} 자동 로드</div>
        </div>
        {lastFetch&&<span style={{fontSize:11,color:"#22c55e"}}>✅ {lastFetch} 갱신</span>}
      </div>
      <div style={{display:"flex",gap:8,alignItems:"center"}}>
        <button onClick={fetchSheets} disabled={sheetLoading}
          style={{padding:"9px 20px",borderRadius:9,border:"none",background:sheetLoading?"#1e3a5f":"#1d4ed8",color:"#fff",cursor:sheetLoading?"wait":"pointer",fontWeight:700,fontSize:13}}>
          {sheetLoading?"⏳ 불러오는 중...":responseData.length?"🔄 새로고침":"📡 대응현황 불러오기"}
        </button>
        {sheetStatus&&(
          <span style={{fontSize:10,padding:"3px 8px",borderRadius:4,background:sheetStatus.ok?"#14532d":"#450a0a",color:sheetStatus.ok?"#22c55e":"#ef4444"}}>
            {sheetStatus.ok?`✅ ${sheetStatus.label} (${sheetStatus.count}건)`:"❌ 실패"}
          </span>
        )}
      </div>
      {sheetErr&&<div style={{color:"#ef4444",fontSize:11,marginTop:8}}>{sheetErr}</div>}
    </div>
  );

  return (
    <div style={{fontFamily:"'Pretendard','Apple SD Gothic Neo',sans-serif",background:"#060d18",minHeight:"100vh",color:"#c8d8f0",padding:18}}>
      {toast&&<div style={{position:"fixed",bottom:32,left:"50%",transform:"translateX(-50%)",zIndex:9999,background:toast.color,color:"#fff",padding:"14px 28px",borderRadius:14,fontWeight:700,fontSize:13,boxShadow:"0 4px 24px rgba(0,0,0,0.6)",whiteSpace:"nowrap"}}>{toast.msg}</div>}

      {/* 헤더 */}
      <div style={{marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <button onClick={onBack}
            style={{padding:"6px 14px",borderRadius:8,border:"1px solid #1e3a5f",background:"#0d1b2e",color:"#4a6fa5",fontSize:11,cursor:"pointer",fontFamily:"inherit"}}
            onMouseEnter={e=>{e.currentTarget.style.borderColor="#4a6fa5";e.currentTarget.style.color="#c8d8f0";}}
            onMouseLeave={e=>{e.currentTarget.style.borderColor="#1e3a5f";e.currentTarget.style.color="#4a6fa5";}}>
            ← 국가 선택
          </button>
          <div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",borderRadius:20,background:`${countryColor}18`,border:`1px solid ${countryColor}44`,fontSize:12,fontWeight:700,color:countryColor}}>
            {countryFlag} {country}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:6,padding:"5px 12px",borderRadius:20,background:"#3b82f618",border:"1px solid #3b82f644",fontSize:12,fontWeight:700,color:"#3b82f6"}}>
            🤖 Google Play
          </div>
          <div>
            <div style={{fontSize:17,fontWeight:800,color:"#e8f4ff",letterSpacing:"-0.03em"}}>🎮 결제취소 악용자 대응현황</div>
            <div style={{fontSize:11,color:"#2d4a6e",marginTop:2}}>2018~현재</div>
          </div>
        </div>
        <div style={{display:"flex",gap:6,fontSize:11}}>
          <span style={{padding:"3px 10px",borderRadius:20,background:hasData?"#14532d":"#0d1b2e",color:hasData?"#22c55e":"#2d4a6e",border:"1px solid #1e3a5f"}}>
            📁 {hasData?`${fmt(allOrderRows.length)}건`:country+" 데이터 없음"}
          </span>
          <span style={{padding:"3px 10px",borderRadius:20,background:hasResp?"#14532d":"#0d1b2e",color:hasResp?"#22c55e":"#2d4a6e",border:"1px solid #1e3a5f"}}>
            📊 {hasResp?`대응현황 ${fmt(responseData.length)}건`:"대응현황 미로드"}
          </span>
        </div>
      </div>

      {/* 탭 */}
      <div style={{display:"flex",gap:2,marginBottom:16,background:"#0a1628",borderRadius:12,padding:4,width:"fit-content",flexWrap:"wrap"}}>
        {TABS.map(t=>(
          <button key={t} onClick={()=>setTab(t)}
            style={{padding:"7px 14px",border:"none",borderRadius:9,fontSize:12,fontWeight:700,cursor:"pointer",background:tab===t?countryColor:"transparent",color:tab===t?"#fff":"#2d4a6e"}}>
            {t}
          </button>
        ))}
      </div>

      {/* ━━━ 마켓 환불 현황 ━━━ */}
      {tab==="마켓 환불 현황"&&(<>
        <FilterBar/>
        {!hasData?(
          <div style={{background:"#0d1b2e",borderRadius:14,padding:40,textAlign:"center",color:"#2d4a6e",fontSize:13,border:"1px dashed #1e3a5f"}}>
            {country} Google Play 데이터가 없습니다.
          </div>
        ):(<>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:10,marginBottom:16}}>
            <Card icon="📋" label="총 환불 주문" value={fmt(stats.totalOrders)} sub="건수 기준" color="#3b82f6"/>
            <Card icon="🔄" label="회수 처리" value={fmt(stats.recovered)} sub={`${stats.totalAbuseUnique?Math.round(stats.recovered/stats.totalAbuseUnique*100):0}%`} color="#22d3ee"/>
            <Card icon="🚫" label="제재 처리" value={fmt(stats.sanctioned)} sub={`${stats.totalAbuseUnique?Math.round(stats.sanctioned/stats.totalAbuseUnique*100):0}%`} color="#ef4444"/>
            <Card icon={country==="한국"?"💰":"💴"} label="환불 금액" value={`${currencySymbol}${fmt(Math.round(stats.amountTotal))}`} sub={currencyCode} color="#f59e0b"/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"2fr 1fr",gap:12,marginBottom:12}}>
            <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
              <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>연도별 환불 추이 ({country} · Google Play)</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={yearlyChart}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#0a1220"/>
                  <XAxis dataKey="year" tick={{fill:"#2d4a6e",fontSize:10}}/>
                  <YAxis tick={{fill:"#2d4a6e",fontSize:10}}/>
                  <Tooltip {...TT}/>
                  <Bar dataKey="주문건수" fill={countryColor} radius={[4,4,0,0]}/>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
              <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>처리 현황</div>
              {[["회수 처리",stats.recovered,"#22d3ee"],["제재 처리",stats.sanctioned,"#ef4444"]].filter(([,v])=>v>0).map(([l,v,c])=>(
                <div key={l} style={{marginBottom:12}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:4}}>
                    <span style={{color:"#4a6fa5"}}>{l}</span>
                    <span style={{color:c,fontWeight:700}}>{fmt(v)}명 ({stats.totalAbuseUnique?Math.round(v/stats.totalAbuseUnique*100):0}%)</span>
                  </div>
                  <div style={{background:"#0a1220",borderRadius:4,height:6}}>
                    <div style={{width:`${stats.totalAbuseUnique?Math.round(v/stats.totalAbuseUnique*100):0}%`,height:"100%",background:c,borderRadius:4}}/>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </>)}
      </>)}

      {/* ━━━ 연도별 분석 ━━━ */}
      {tab==="연도별 분석"&&(<>
        <FilterBar/>
        {/* 구글 시트 미로드시 안내 */}
        {!hasResp&&hasData&&(
          <div style={{background:"#0d1b2e",borderRadius:12,padding:"10px 16px",marginBottom:12,border:"1px solid #f59e0b44",display:"flex",alignItems:"center",gap:12}}>
            <span style={{fontSize:12,color:"#f59e0b"}}>⚠️ 복구금액을 보려면 CS대응현황 데이터를 먼저 불러오세요</span>
            <button onClick={fetchSheets} style={{padding:"5px 14px",borderRadius:7,border:"none",background:"#1d4ed8",color:"#fff",cursor:"pointer",fontWeight:700,fontSize:11}}>
              📡 불러오기
            </button>
          </div>
        )}
        {!hasData?<div style={{background:"#0d1b2e",borderRadius:14,padding:40,textAlign:"center",color:"#2d4a6e",fontSize:13}}>데이터가 없습니다.</div>:(<>
          <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f",marginBottom:12}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
              <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600}}>연도별 현황 ({country} · Google Play)</div>
              <button onClick={()=>{
                const wb2=XLSX.utils.book_new();
                // ━━━ 연도별 데이터 ━━━
                const yearRows=yearlyChart.map(row=>{
                  const yas=yearlyAbuseStats[row.year]||{sanctioned:0,recovered:0,resanctioned:0,recoveredAmount:0};
                  const r={"구분":"연도별","연도":row.year+"년","주문건수":row.주문건수,"제재건수":yas.sanctioned,"복구수":yas.recovered,"복구율":yas.sanctioned?Math.round(yas.recovered/yas.sanctioned*100)+"%":"0%","재제재수":yas.resanctioned,"재제재율":yas.sanctioned?Math.round(yas.resanctioned/yas.sanctioned*100)+"%":"0%"};
                  r["복구금액("+currencyCode+")"]=Math.round(yas.recoveredAmount||0);
                  return r;
                });
                // 합계행
                const totSanc=Object.values(yearlyAbuseStats).reduce((s,v)=>s+v.sanctioned,0);
                const totRec=Object.values(yearlyAbuseStats).reduce((s,v)=>s+v.recovered,0);
                const totRes=Object.values(yearlyAbuseStats).reduce((s,v)=>s+v.resanctioned,0);
                const totAmt=Object.values(yearlyAbuseStats).reduce((s,v)=>s+(v.recoveredAmount||0),0);
                const totRow={"구분":"합계","연도":"합계","주문건수":yearlyChart.reduce((s,r)=>s+r.주문건수,0),"제재건수":totSanc,"복구수":totRec,"복구율":totSanc?Math.round(totRec/totSanc*100)+"%":"0%","재제재수":totRes,"재제재율":totSanc?Math.round(totRes/totSanc*100)+"%":"0%"};
                totRow["복구금액("+currencyCode+")"]=Math.round(totAmt);
                yearRows.push(totRow);
                // ━━━ 구분선 ━━━
                yearRows.push({});
                // ━━━ 월별 상세 데이터 ━━━
                yearlyChart.forEach(row=>{
                  const months=monthlyStats[row.year]||[];
                  months.forEach(m=>{
                    const mr={"구분":"월별","연도":row.year+"년","월":m.month,"주문건수":m.orders,"제재건수":m.sanctioned||0,"복구수":m.recovered||0,"복구율":(m.sanctioned?Math.round((m.recovered||0)/m.sanctioned*100):0)+"%","재제재수":m.resanctioned||0,"재제재율":(m.sanctioned?Math.round((m.resanctioned||0)/m.sanctioned*100):0)+"%"};
                    mr["복구금액("+currencyCode+")"]=Math.round(m.recoveredAmount||0);
                    yearRows.push(mr);
                  });
                  // 연도 소계
                  const ms=months.reduce((s,m)=>({orders:s.orders+m.orders,sanctioned:s.sanctioned+(m.sanctioned||0),recovered:s.recovered+(m.recovered||0),resanctioned:s.resanctioned+(m.resanctioned||0),recoveredAmount:s.recoveredAmount+(m.recoveredAmount||0)}),{orders:0,sanctioned:0,recovered:0,resanctioned:0,recoveredAmount:0});
                  const sr={"구분":"소계","연도":row.year+"년 소계","월":"합계","주문건수":ms.orders,"제재건수":ms.sanctioned,"복구수":ms.recovered,"복구율":ms.sanctioned?Math.round(ms.recovered/ms.sanctioned*100)+"%":"0%","재제재수":ms.resanctioned,"재제재율":ms.sanctioned?Math.round(ms.resanctioned/ms.sanctioned*100)+"%":"0%"};
                  sr["복구금액("+currencyCode+")"]=Math.round(ms.recoveredAmount);
                  yearRows.push(sr);
                  yearRows.push({});
                });
                const ws=XLSX.utils.json_to_sheet(yearRows);
                XLSX.utils.book_append_sheet(wb2,ws,"연도_월별_분석");
                XLSX.writeFile(wb2,`${country}_Google_연도월별분석_${new Date().toISOString().slice(0,10)}.xlsx`);
              }} style={{padding:"8px 16px",borderRadius:8,border:"none",background:"#16a34a",color:"#fff",cursor:"pointer",fontWeight:700,fontSize:12}}>📥 엑셀 다운로드</button>
            </div>
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                <thead>
                  <tr style={{background:"#060d18",borderBottom:"1px solid #1e3a5f"}}>
                    {[{label:"연도",color:"#2d4a6e"},{label:"주문건수",color:"#3b82f6"},{label:"제재건수",color:"#ef4444"},{label:"복구수",color:"#22c55e"},{label:"복구율",color:"#22c55e"},{label:"복구금액",color:"#a78bfa"},{label:"재제재수",color:"#f59e0b"},{label:"재제재율",color:"#f59e0b"}].map(({label,color})=>(
                      <th key={label} style={{padding:"8px 10px",textAlign:"center",color,fontWeight:600,whiteSpace:"nowrap"}}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {yearlyChart.flatMap((row,i)=>{
                    const yas=yearlyAbuseStats[row.year]||{sanctioned:0,recovered:0,resanctioned:0,recoveredAmount:0};
                    const months = monthlyStats[row.year]||[];
                    const mainRow = (
                      <tr key={`yr-${i}`}
                        onClick={()=>setExpandedYear(expandedYear===row.year?null:row.year)}
                        style={{borderBottom:"1px solid #0a1220",cursor:"pointer",background:expandedYear===row.year?"#0a1e3a":"transparent"}}
                        onMouseEnter={e=>{ if(expandedYear!==row.year) e.currentTarget.style.background="#0a1528"; }}
                        onMouseLeave={e=>{ if(expandedYear!==row.year) e.currentTarget.style.background="transparent"; }}>
                        <td style={{padding:"8px 10px",fontWeight:700,color:"#e8f4ff",textAlign:"center"}}>
                          <span style={{marginRight:6,color:countryColor}}>{expandedYear===row.year?"▼":"▶"}</span>{row.year}년
                        </td>
                        <td style={{padding:"7px 10px",color:"#3b82f6",textAlign:"center",fontWeight:700}}>{fmt(row.주문건수)}</td>
                        <td style={{padding:"7px 10px",color:"#ef4444",textAlign:"center",fontWeight:700}}>{fmt(yas.sanctioned)}</td>
                        <td style={{padding:"7px 10px",color:"#22c55e",textAlign:"center",fontWeight:700}}>
                          <HoverTooltip lines={[
                            {label:"✅ 복구완료 OpenID 목록", value:`총 ${(yas.recoveredOids||[]).length}명`, color:"#22c55e"},
                            ...(yas.recoveredOids||[]).map((oid,i)=>({label:`${i+1}.`, value:oid, color:"#c8d8f0", mono:true}))
                          ]}>
                            {fmt(yas.recovered)}
                          </HoverTooltip>
                        </td>
                        <td style={{padding:"7px 10px",color:"#22c55e",textAlign:"center"}}>{yas.sanctioned?Math.round(yas.recovered/yas.sanctioned*100):0}%</td>
                        <td style={{padding:"7px 10px",color:"#a78bfa",textAlign:"center",fontWeight:700}}>
                          <HoverTooltip lines={[
                            {label:"💰 복구금액 주문 상세", value:`총 ${currencySymbol}${fmt(Math.round(yas.recoveredAmount||0))}`, color:"#a78bfa"},
                            ...(yas.recoveredOrders||[]).map((o,i)=>({label:o.orderNo||`주문${i+1}`, value:`${o.openid?.slice(0,10)}… ${currencySymbol}${fmt(Math.round(o.amount))}`, color:"#c8d8f0", mono:true}))
                          ]}>
                            {currencySymbol}{fmt(Math.round(yas.recoveredAmount||0))}
                          </HoverTooltip>
                        </td>
                        <td style={{padding:"7px 10px",color:"#f59e0b",textAlign:"center",fontWeight:700}}>{fmt(yas.resanctioned)}</td>
                        <td style={{padding:"7px 10px",color:"#f59e0b",textAlign:"center"}}>{yas.sanctioned?Math.round(yas.resanctioned/yas.sanctioned*100):0}%</td>
                      </tr>
                    );
                    const detailRow = expandedYear===row.year ? (
                      <tr key={`det-${i}`} style={{background:"#060d18"}}>
                        <td colSpan={8} style={{padding:0}}>
                          <div style={{padding:"10px 20px",borderBottom:"1px solid #1e3a5f"}}>
                            <div style={{fontSize:11,color:countryColor,fontWeight:700,marginBottom:8}}>📅 {row.year}년 월별 상세</div>
                            <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                              <thead>
                                <tr style={{borderBottom:"1px solid #1e3a5f22"}}>
                                  {[{l:"월",c:"#2d4a6e"},{l:"주문건수",c:"#3b82f6"},{l:"제재건수",c:"#ef4444"},{l:"복구수",c:"#22c55e"},{l:"복구율",c:"#22c55e"},{l:"복구금액",c:"#a78bfa"},{l:"재제재수",c:"#f59e0b"},{l:"재제재율",c:"#f59e0b"}].map(({l,c})=>(
                                    <th key={l} style={{padding:"5px 8px",textAlign:"center",color:c,fontWeight:600,whiteSpace:"nowrap"}}>{l}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>
                                {months.map((m,mi)=>(
                                  <tr key={mi} style={{borderBottom:"1px solid #0a122011"}}>
                                    <td style={{padding:"5px 8px",color:"#4a6fa5",textAlign:"center",fontWeight:600}}>{m.month}</td>
                                    <td style={{padding:"5px 8px",color:"#3b82f6",textAlign:"center",fontWeight:700}}>{fmt(m.orders)}</td>
                                    <td style={{padding:"5px 8px",color:"#ef4444",textAlign:"center"}}>{fmt(m.sanctioned||0)}</td>
                                    <td style={{padding:"5px 8px",color:"#22c55e",textAlign:"center",fontWeight:700}}>
                                      <HoverTooltip lines={[
                                        {label:"✅ 복구 OpenID", value:`${(m.recoveredOids||[]).length}명`, color:"#22c55e"},
                                        ...(m.recoveredOids||[]).map((oid,i)=>({label:`${i+1}.`, value:oid, color:"#c8d8f0", mono:true}))
                                      ]}>
                                        {fmt(m.recovered||0)}
                                      </HoverTooltip>
                                    </td>
                                    <td style={{padding:"5px 8px",color:"#22c55e",textAlign:"center"}}>{m.sanctioned?Math.round((m.recovered||0)/m.sanctioned*100):0}%</td>
                                    <td style={{padding:"5px 8px",color:"#a78bfa",textAlign:"center"}}>
                                      <HoverTooltip lines={[
                                        {label:"💰 주문 상세", value:`${currencySymbol}${fmt(Math.round(m.recoveredAmount||0))}`, color:"#a78bfa"},
                                        ...(m.recoveredOrders||[]).map((o,i)=>({label:o.orderNo||`주문${i+1}`, value:`${o.openid?.slice(0,10)}… ${currencySymbol}${fmt(Math.round(o.amount))}`, color:"#c8d8f0", mono:true}))
                                      ]}>
                                        {currencySymbol}{fmt(Math.round(m.recoveredAmount||0))}
                                      </HoverTooltip>
                                    </td>
                                    <td style={{padding:"5px 8px",color:"#f59e0b",textAlign:"center"}}>{fmt(m.resanctioned||0)}</td>
                                    <td style={{padding:"5px 8px",color:"#f59e0b",textAlign:"center"}}>{m.sanctioned?Math.round((m.resanctioned||0)/m.sanctioned*100):0}%</td>
                                  </tr>
                                ))}
                                <tr style={{borderTop:"1px solid #1e3a5f33",fontWeight:700,background:"#0a1528"}}>
                                  <td style={{padding:"5px 8px",color:"#e8f4ff",textAlign:"center"}}>합계</td>
                                  <td style={{padding:"5px 8px",color:"#3b82f6",textAlign:"center"}}>{fmt(months.reduce((s,m)=>s+m.orders,0))}</td>
                                  <td style={{padding:"5px 8px",color:"#ef4444",textAlign:"center"}}>{fmt(months.reduce((s,m)=>s+(m.sanctioned||0),0))}</td>
                                  <td style={{padding:"5px 8px",color:"#22c55e",textAlign:"center"}}>{fmt(months.reduce((s,m)=>s+(m.recovered||0),0))}</td>
                                  <td style={{padding:"5px 8px",color:"#22c55e",textAlign:"center"}}>{(()=>{const ts=months.reduce((s,m)=>s+(m.sanctioned||0),0);const tr=months.reduce((s,m)=>s+(m.recovered||0),0);return ts?Math.round(tr/ts*100):0;})()}%</td>
                                  <td style={{padding:"5px 8px",color:"#a78bfa",textAlign:"center"}}>{currencySymbol}{fmt(Math.round(months.reduce((s,m)=>s+(m.recoveredAmount||0),0)))}</td>
                                  <td style={{padding:"5px 8px",color:"#f59e0b",textAlign:"center"}}>{fmt(months.reduce((s,m)=>s+(m.resanctioned||0),0))}</td>
                                  <td style={{padding:"5px 8px",color:"#f59e0b",textAlign:"center"}}>{(()=>{const ts=months.reduce((s,m)=>s+(m.sanctioned||0),0);const tr=months.reduce((s,m)=>s+(m.resanctioned||0),0);return ts?Math.round(tr/ts*100):0;})()}%</td>
                                </tr>
                              </tbody>
                            </table>
                          </div>
                        </td>
                      </tr>
                    ) : null;
                    return [mainRow, detailRow].filter(Boolean);
                  })}
                  {(()=>{
                    const totOrders=yearlyChart.reduce((s,r)=>s+r.주문건수,0);
                    const totSanc=Object.values(yearlyAbuseStats).reduce((s,v)=>s+v.sanctioned,0);
                    const totRec=Object.values(yearlyAbuseStats).reduce((s,v)=>s+v.recovered,0);
                    const totRes=Object.values(yearlyAbuseStats).reduce((s,v)=>s+v.resanctioned,0);
                    return(<tr style={{borderTop:"2px solid #1e3a5f",background:"#0a1528",fontWeight:700}}>
                      <td style={{padding:"8px 10px",color:"#e8f4ff",textAlign:"center"}}>합계</td>
                      <td style={{padding:"7px 10px",color:"#3b82f6",textAlign:"center"}}>{fmt(totOrders)}</td>
                      <td style={{padding:"7px 10px",color:"#ef4444",textAlign:"center"}}>{fmt(totSanc)}</td>
                      <td style={{padding:"7px 10px",color:"#22c55e",textAlign:"center"}}>{fmt(totRec)}</td>
                      <td style={{padding:"7px 10px",color:"#22c55e",textAlign:"center"}}>{totSanc?Math.round(totRec/totSanc*100):0}%</td>
                      <td style={{padding:"7px 10px",color:"#a78bfa",textAlign:"center"}}>{currencySymbol}{fmt(Math.round(Object.values(yearlyAbuseStats).reduce((s,v)=>s+(v.recoveredAmount||0),0)))}</td>
                      <td style={{padding:"7px 10px",color:"#f59e0b",textAlign:"center"}}>{fmt(totRes)}</td>
                      <td style={{padding:"7px 10px",color:"#f59e0b",textAlign:"center"}}>{totSanc?Math.round(totRes/totSanc*100):0}%</td>
                    </tr>);
                  })()}
                </tbody>
              </table>
            </div>
          </div>

        </>)}
      </>)}

      {/* ━━━ CS대응현황 ━━━ */}
      {tab==="CS대응현황"&&(<>
        <SheetBox/>
        <FilterBar/>
        {!hasResp?(
          <div style={{background:"#0d1b2e",borderRadius:14,padding:40,textAlign:"center",color:"#2d4a6e",fontSize:13,border:"1px dashed #1e3a5f"}}>
            위 버튼으로 {country} Google Sheets 데이터를 불러오세요.
          </div>
        ):(<>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:14}}>
            <Card icon="📋" label="총 제재 대상" value={fmt(stats.totalAbuseUnique)} sub="악용자 리스트 기준" color="#3b82f6"/>
            <Card icon="✅" label="복구 완료" value={fmt(stats.respRecovered)} sub={`${stats.totalAbuseUnique?Math.round(stats.respRecovered/stats.totalAbuseUnique*100):0}%`} color="#22c55e"/>
            <Card icon="🚫" label="재제재" value={fmt(stats.respResanctioned)} sub={`${stats.totalAbuseUnique?Math.round(stats.respResanctioned/stats.totalAbuseUnique*100):0}%`} color="#ef4444"/>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
            {[["복구완료","#22c55e"],["재제재","#ef4444"]].map(([s,c])=>{
              const cnt=s==="복구완료"?stats.respRecovered:stats.respResanctioned;
              return(<button key={s} onClick={()=>setCsStatusTab(csStatusTab===s?"":s)}
                style={{padding:"10px 22px",borderRadius:10,border:`2px solid ${csStatusTab===s?c:"#1e3a5f"}`,background:csStatusTab===s?c+"22":"#0d1b2e",color:csStatusTab===s?c:"#4a6fa5",fontWeight:700,fontSize:12,cursor:"pointer"}}>
                {s==="복구완료"?"✅":s==="재제재"?"🚫":"⏳"} {s} ({fmt(cnt)})
              </button>);
            })}
          </div>
          {csStatusTab&&(()=>{
            const c=csStatusTab==="복구완료"?"#22c55e":csStatusTab==="재제재"?"#ef4444":"#f59e0b";
            const oids=Object.entries(sheetOidMap).filter(([,v])=>{
              if(yearFilter!=="전체"&&v.lastDate?.slice(0,4)!==yearFilter) return false;
              return v.status===csStatusTab;
            });
            return(<div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:`1px solid ${c}44`,marginBottom:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <div style={{fontSize:13,fontWeight:700,color:c}}>
                  {csStatusTab==="복구완료"?"✅":csStatusTab==="재제재"?"🚫":"⏳"} {csStatusTab} 유저 목록
                  <span style={{fontSize:11,color:"#4a6fa5",marginLeft:8}}>총 {fmt(oids.length)}명</span>
                </div>
                <button onClick={()=>setCsStatusTab("")} style={{background:"none",border:"none",color:"#4a6fa5",cursor:"pointer",fontSize:18}}>✕</button>
              </div>
              <div style={{overflowX:"auto",maxHeight:400,overflowY:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:11}}>
                  <thead style={{position:"sticky",top:0,background:"#060d18",zIndex:1}}>
                    <tr style={{borderBottom:"1px solid #1e3a5f"}}>
                      {["#","OpenID","최종처리일"].map(h=><th key={h} style={{padding:"8px 10px",textAlign:"left",color:"#2d4a6e",fontWeight:600}}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {oids.map(([oid,v],i)=>(
                      <tr key={oid} style={{borderBottom:"1px solid #0a1220",cursor:"pointer"}}
                        onMouseEnter={e=>e.currentTarget.style.background="#0a1528"}
                        onMouseLeave={e=>e.currentTarget.style.background="transparent"}
                        onClick={()=>{setSearchQ(oid);setTab("유저 조회");setTimeout(()=>doSearch(),100);}}>
                        <td style={{padding:"7px 10px",color:"#2d4a6e"}}>{i+1}</td>
                        <td style={{padding:"7px 10px",color:"#c8d8f0",fontFamily:"monospace",fontSize:10}}>{oid}</td>
                        <td style={{padding:"7px 10px",color:"#2d4a6e"}}>{v.lastDate}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>);
          })()}
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
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
              <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:14}}>처리 결과 비율</div>
              <ResponsiveContainer width="100%" height={160}>
                <PieChart>
                  <Pie data={[{name:"복구완료",value:stats.respRecovered},{name:"재제재",value:stats.respResanctioned}].filter(d=>d.value>0)} cx="50%" cy="50%" innerRadius={45} outerRadius={65} dataKey="value" paddingAngle={3}>
                    {[{color:"#22c55e"},{color:"#ef4444"},{color:"#f59e0b"}].map((e,i)=><Cell key={i} fill={e.color}/>)}
                  </Pie>
                  <Tooltip {...TT}/>
                </PieChart>
              </ResponsiveContainer>
              {[["복구완료",stats.respRecovered,"#22c55e"],["재제재",stats.respResanctioned,"#ef4444"]].map(([l,v,c])=>(
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
      {tab==="유저 조회"&&(
        <div>
          <div style={{background:"#0d1b2e",borderRadius:12,padding:12,marginBottom:14,borderLeft:`4px solid ${countryColor}`}}>
            <div style={{fontSize:12,color:countryColor,fontWeight:700}}>🔍 유저 조회 — {country} Google Play 전용</div>
            <div style={{fontSize:11,color:"#2d4a6e",marginTop:2}}>OpenID 검색 → 주문내역 + 악용자 정보 + 처리 히스토리</div>
          </div>
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            <input value={searchQ} onChange={e=>setSearchQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&doSearch()}
              placeholder="OpenID 입력 후 Enter"
              style={{flex:1,padding:"10px 14px",borderRadius:10,border:"1px solid #1e3a5f",background:"#0d1b2e",color:"#c8d8f0",fontSize:13,outline:"none"}}/>
            <button onClick={doSearch}
              style={{padding:"10px 20px",borderRadius:10,border:"none",background:countryColor,color:"#fff",cursor:"pointer",fontWeight:700,fontSize:13}}>조회</button>
          </div>
          {searchRes&&(
            <div style={{display:"flex",flexDirection:"column",gap:12}}>
              <div style={{background:"#0d1b2e",borderRadius:14,padding:16,border:"1px solid #1e3a5f"}}>
                <div style={{fontSize:14,fontWeight:800,color:"#e8f4ff",marginBottom:12}}>👤 {searchRes.q}</div>
                <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                  {[["환불 주문",searchRes.orders.length+"건","#3b82f6"],["악용 횟수",searchRes.abuse?searchRes.abuse.abuseCount+"회":"없음","#f59e0b"],["대응 이력",searchRes.history.length+"건","#8b5cf6"],["최신 상태",searchRes.latestStatus?.status||"없음",STATUS_COLORS[searchRes.latestStatus?.status]||"#4a6fa5"]].map(([l,v,c])=>(
                    <div key={l} style={{background:"#060d18",borderRadius:10,padding:"8px 14px"}}>
                      <div style={{fontSize:10,color:"#2d4a6e"}}>{l}</div>
                      <div style={{fontSize:14,fontWeight:700,color:c,marginTop:2}}>{v}</div>
                    </div>
                  ))}
                </div>
                {searchRes.abuse&&(
                  <div style={{background:"#060d18",borderRadius:8,padding:10,fontSize:11,color:"#4a6fa5",marginTop:10}}>
                    누적 획득 UC: <span style={{color:"#3b82f6"}}>{fmt(searchRes.abuse.totalUC)}</span> · 현재 보유 UC: <span style={{color:"#22c55e"}}>{fmt(searchRes.abuse.currentUC)}</span> · P값: <span style={{color:"#22d3ee"}}>{fmt(searchRes.abuse.pValue)}</span>
                  </div>
                )}
              </div>
              {/* 대응 히스토리 타임라인 */}
              {searchRes.history.length>0&&(
                <div style={{background:"#0d1b2e",borderRadius:14,padding:18,border:"1px solid #1e3a5f"}}>
                  <div style={{fontSize:13,color:"#4a6fa5",fontWeight:600,marginBottom:16}}>
                    📋 대응 히스토리 ({searchRes.history.length}건 · 날짜순)
                  </div>
                  {searchRes.history.map((h,i)=>{
                    const col=STATUS_COLORS[h.status]||"#4a6fa5";
                    const isLast=i===searchRes.history.length-1;
                    return(
                      <div key={i} style={{display:"flex",gap:14,alignItems:"flex-start"}}>
                        <div style={{display:"flex",flexDirection:"column",alignItems:"center"}}>
                          <div style={{width:30,height:30,borderRadius:"50%",background:isLast?col:col+"33",border:`2px solid ${col}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,flexShrink:0}}>
                            {h.status==="복구완료"?"✅":"🚫"}
                          </div>
                          {!isLast&&<div style={{width:2,height:32,background:"#1e3a5f"}}/>}
                        </div>
                        <div style={{paddingBottom:isLast?0:12,flex:1,background:isLast?col+"11":"transparent",borderRadius:isLast?8:0,padding:isLast?"8px 12px":"0 0 12px 0",border:isLast?`1px solid ${col}33`:"none"}}>
                          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4,flexWrap:"wrap"}}>
                            <span style={{fontSize:12,fontWeight:700,color:"#e8f4ff"}}>{h.date}</span>
                            <span style={{padding:"2px 8px",borderRadius:4,fontSize:10,background:col+"22",color:col}}>{h.status}</span>
                            {isLast&&<span style={{fontSize:10,color:col,fontWeight:700}}>← 최신</span>}
                          </div>
                          {h.resultText&&<div style={{fontSize:11,color:"#4a6fa5",whiteSpace:"pre-wrap",wordBreak:"break-all"}}>{h.resultText.slice(0,200)}{h.resultText.length>200?"...":""}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
              {searchRes.orders.length===0&&searchRes.history.length===0&&(
                <div style={{background:"#0d1b2e",borderRadius:14,padding:24,textAlign:"center",color:"#2d4a6e",fontSize:13}}>
                  <strong style={{color:"#c8d8f0"}}>{searchRes.q}</strong> — {country} Google Play 데이터 없음
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ━━━ AI 분석 ━━━ */}
      {tab==="AI 분석"&&(
        <div style={{display:"flex",flexDirection:"column",height:"calc(100vh - 260px)",minHeight:400}}>
          <div style={{background:"#0d1b2e",borderRadius:12,padding:12,marginBottom:12,borderLeft:`4px solid ${countryColor}`}}>
            <div style={{fontSize:12,color:countryColor,fontWeight:700}}>🤖 AI 데이터 분석 — {country} Google Play 전용</div>
            <div style={{fontSize:11,color:"#2d4a6e",marginTop:2}}>{country} 데이터 기반으로 자유롭게 질문하세요</div>
          </div>
          <div style={{flex:1,background:"#0d1b2e",borderRadius:14,padding:16,border:"1px solid #1e3a5f",overflowY:"auto",marginBottom:12}}>
            {chatMessages.map((m,i)=>(
              <div key={i} style={{display:"flex",justifyContent:m.role==="user"?"flex-end":"flex-start",marginBottom:12}}>
                <div style={{maxWidth:"80%",padding:"10px 14px",borderRadius:12,background:m.role==="user"?countryColor:"#0a1628",color:"#fff",fontSize:13,lineHeight:1.6,whiteSpace:"pre-wrap",border:m.role==="assistant"?"1px solid #1e3a5f":"none"}}>
                  {m.content}
                </div>
              </div>
            ))}
            {chatLoading&&<div style={{display:"flex",justifyContent:"flex-start",marginBottom:12}}><div style={{padding:"10px 14px",borderRadius:12,background:"#0a1628",border:"1px solid #1e3a5f",color:countryColor,fontSize:13}}>⏳ 분석 중...</div></div>}
            <div ref={chatEndRef}/>
          </div>
          <div style={{display:"flex",gap:8}}>
            <input value={chatInput} onChange={e=>setChatInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendChat()}
              placeholder={`${country} Google Play 데이터 질문...`}
              style={{flex:1,padding:"12px 16px",borderRadius:12,border:"1px solid #1e3a5f",background:"#0d1b2e",color:"#c8d8f0",fontSize:13,outline:"none"}}/>
            <button onClick={sendChat} disabled={chatLoading}
              style={{padding:"12px 20px",borderRadius:12,border:"none",background:chatLoading?"#1e3a5f":countryColor,color:"#fff",cursor:chatLoading?"wait":"pointer",fontWeight:700,fontSize:13}}>전송</button>
          </div>
        </div>
      )}

      <div style={{marginTop:16,padding:"8px 14px",background:"#0d1b2e",borderRadius:10,fontSize:10,color:"#1e3a5f",borderLeft:`3px solid ${countryColor}`}}>
        {countryFlag} {country} · 🤖 Google Play 전용 대시보드
      </div>
    </div>
  );
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 메인 앱
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
export default function App() {
  const [screen, setScreen] = useState("landing");
  const [parsedData, setParsedData] = useState(null);
  const [uploadLog, setUploadLog] = useState([]);
  const [fileNames, setFileNames] = useState([]);
  const [toast, setToast] = useState(null);

  const showToast = (msg, color="#22c55e") => { setToast({msg,color}); setTimeout(()=>setToast(null),3000); };

  const handleFile = useCallback(async (file) => {
    if (!file) return;
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab);
      const parsed = parseExcelFile(wb);
      setParsedData(prev => {
        if (!prev) return parsed;
        return { orderRows:[...prev.orderRows,...parsed.orderRows], abuseRows:[...prev.abuseRows,...parsed.abuseRows], abuseMap:{...prev.abuseMap,...parsed.abuseMap}, oidInfo:{...prev.oidInfo,...parsed.oidInfo}, log:[...prev.log,...parsed.log] };
      });
      setUploadLog(prev=>[...prev,...parsed.log]);
      setFileNames(prev=>prev.includes(file.name)?prev:[...prev,file.name]);
      const kr=parsed.orderRows.filter(d=>d.country==="한국").length;
      const jp=parsed.orderRows.filter(d=>d.country==="일본").length;
      showToast(`✅ ${file.name.slice(0,20)} 완료! 한국 ${kr}건 · 일본 ${jp}건`);
    } catch(e) { showToast("❌ 파싱 오류: "+e.message,"#ef4444"); }
  }, []);

  return (
    <>
      {toast&&<div style={{position:"fixed",bottom:32,left:"50%",transform:"translateX(-50%)",zIndex:9999,background:toast.color,color:"#fff",padding:"14px 28px",borderRadius:14,fontWeight:700,fontSize:13,boxShadow:"0 4px 24px rgba(0,0,0,0.6)",whiteSpace:"nowrap",maxWidth:"90vw",overflow:"hidden",textOverflow:"ellipsis"}}>{toast.msg}</div>}
      {screen==="landing"&&<LandingPage onEnter={setScreen} parsedData={parsedData} uploadLog={uploadLog} onFile={handleFile} fileNames={fileNames}/>}
      {(screen==="한국"||screen==="일본")&&parsedData&&<Dashboard country={screen} parsedData={parsedData} onBack={()=>setScreen("landing")}/>}
    </>
  );
}
