// Gemini API 호출 모듈 — Vercel 함수(api/request.js)와 수집기(collector/worker.mjs)가 함께 쓴다
// 필요한 환경변수: GEMINI_API_KEY, (선택) GEMINI_MODEL

// 2026-11-03 시험: 2.5-flash 는 신규 사용자 차단, 3.8-flash 는 과부하(503). 가볍고 빠른 lite 모델로 정했다
const DEFAULT_MODEL = 'gemini-3.5-flash-lite'

// 프롬프트를 보내고 JSON 응답을 객체로 돌려준다
export async function geminiJson(prompt) {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY 가 설정되지 않았습니다')
  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL

  // 과부하(503) · 요청 한도(429) · 시간 초과 · 연결 오류는 잠깐 기다렸다가 3번까지 다시 시도한다
  let res
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          // 응답이 없으면 30초 뒤 포기한다 (Vercel 함수 실행 시간 제한 대비)
          signal: AbortSignal.timeout(30_000),
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json', temperature: 0 },
          }),
        },
      )
      if (![429, 503].includes(res.status) || attempt >= 3) break
    } catch (e) {
      if (attempt >= 3) throw new Error(`Gemini 응답 없음(${attempt}회 시도): ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, 1500 * attempt))
  }
  if (!res.ok) {
    throw new Error(`Gemini 호출 실패 (${res.status}): ${(await res.text()).slice(0, 300)}`)
  }
  const data = await res.json()
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? ''
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`Gemini 응답이 JSON이 아닙니다: ${text.slice(0, 200)}`)
  }
}

// 사용자 입력 → { name, kind, keyword } 또는 { error }
export async function parseQuery(query) {
  const prompt = `너는 한국 지도 검색어 해석기다. 사용자 입력에서 "구획"과 "업종 키워드"를 뽑아라.

규칙
- kind 는 셋 중 하나
  - "admin": 행정구역(시 · 구 · 동 · 읍 · 면). 예: 역삼1동, 서교동, 마포구
  - "road": 도로명(…로, …길, …대로). 예: 테헤란로, 세종대로
  - "poi": 역 · 랜드마크 · 상권 같은 지명. 예: 강남역, 홍대입구, 경리단길 상권
- name 은 네이버 지도에 그대로 검색할 수 있는 정식 이름으로 쓴다. "근처", "주변", "맛집" 같은 말은 뺀다
- keyword 는 사용자가 특정 음식 · 업종을 말했을 때만 넣는다(예: 국밥, 카페). 없으면 빈 문자열
- 입력이 장소를 가리키지 않으면 {"error": "이유"} 만 돌려준다

예
- "테헤란로" → {"name":"테헤란로","kind":"road","keyword":""}
- "강남역 근처 국밥집" → {"name":"강남역","kind":"poi","keyword":"국밥"}
- "역삼1동 카페" → {"name":"역삼1동","kind":"admin","keyword":"카페"}

JSON 으로만 답한다: {"name": string, "kind": "admin"|"road"|"poi", "keyword": string}

입력: ${JSON.stringify(query)}`

  const out = await geminiJson(prompt)
  if (out.error) return { error: String(out.error) }
  if (!out.name || !['admin', 'road', 'poi'].includes(out.kind)) {
    return { error: '입력을 구획으로 해석하지 못했습니다' }
  }
  return { name: String(out.name).trim(), kind: out.kind, keyword: String(out.keyword ?? '').trim() }
}

// 업종 키워드(예: 국밥)에 맞는 업장만 고른다. 반환: 남길 업장의 인덱스 배열
// 식당 · 술집 구분은 상가정보 업종 코드로 이미 끝났으므로 여기서는 키워드만 본다
export async function filterByKeyword(places, keyword) {
  const keep = []
  const BATCH = 150
  for (let start = 0; start < places.length; start += BATCH) {
    const batch = places.slice(start, start + BATCH).map((p, i) => ({
      i: start + i,
      name: p.name,
      category: p.category ?? '',
    }))
    const prompt = `업장 목록에서 "${keyword}" 와 관련된 업장의 i 만 골라라.
상호와 업종으로 판단한다. 예: "국밥" → 국밥집, 순대국, 해장국, 설렁탕집은 포함하고 카페 · 치킨은 제외

JSON 으로만 답한다: {"keep": [i, ...]}

목록: ${JSON.stringify(batch)}`
    const out = await geminiJson(prompt)
    const valid = new Set(batch.map((b) => b.i))
    for (const i of out.keep ?? []) if (valid.has(i)) keep.push(i)
  }
  return keep
}
