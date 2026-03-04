export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  try {
    const { csvSample, totalRows } = req.body;

    const prompt = `당신은 Google Sheets CSV 데이터 분석 전문가입니다.

아래는 환불 대응현황 CSV의 처음 5행입니다. 이 데이터를 분석하여 정확한 컬럼 매핑을 JSON으로 반환해주세요.

CSV 샘플:
${csvSample}

총 행 수: ${totalRows}

반드시 아래 JSON 형식으로만 응답하세요 (다른 텍스트 없이):
{
  "columns": {
    "date": "Date 컬럼의 실제 헤더명",
    "openid": "openid 컬럼의 실제 헤더명",
    "cancelOrderNo": "결제취소 주문번호 컬럼의 실제 헤더명",
    "cancelProduct": "결제취소 상품명 컬럼의 실제 헤더명",
    "requestDate": "해제 요청 일시 컬럼의 실제 헤더명",
    "ticketNo": "Ticket NO 컬럼의 실제 헤더명",
    "releaseDate": "해제 일시 컬럼의 실제 헤더명",
    "rechargeOrderNo": "재결제 주문번호 컬럼의 실제 헤더명",
    "rechargeProduct": "재결제 상품명 컬럼의 실제 헤더명",
    "rechargeAmount": "재결제 금액 컬럼의 실제 헤더명",
    "ticketNo2": "티켓 번호 컬럼의 실제 헤더명 (없으면 null)",
    "processDate": "처리날짜 컬럼의 실제 헤더명",
    "processResult": "처리결과 컬럼의 실제 헤더명"
  },
  "statusRules": {
    "recovered": ["처리결과에서 복구완료로 판단할 키워드 목록"],
    "resanctioned": ["처리결과에서 재제재로 판단할 키워드 목록"],
    "processing": "빈칸이면 처리중"
  },
  "notes": "데이터에 대한 특이사항 메모"
}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    
    if (data.error) {
      return res.status(400).json({ error: data.error.message });
    }

    const text = data.content?.[0]?.text || '';
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return res.status(200).json(parsed);
    }
    
    return res.status(200).json({ raw: text });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
