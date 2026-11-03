// 수집기 — 내 PC에서 실행한다
// Supabase 의 수집 대기(pending) 구획을 가져와
//   ① Aside 로 네이버 지도에서 구획 좌표를 얻고
//   ② 상가정보 API 로 구획 안 업장을 가져와
//   ③ 결과를 Supabase 에 저장한다
//
// 실행
//   npm start                              계속 돌며 10초마다 새 요청 확인
//   npm run once                           대기 요청 하나만 처리하고 종료
//   node --env-file=.env worker.mjs --dry 좌표.json   Aside · Supabase 없이 ②만 시험 (좌표 파일은 Aside 출력 JSON 형식)
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createClient } from '@supabase/supabase-js'
import { buildRegionPolygon, centerOf, toQueryWkts, insideRegion } from './geo.mjs'
import { filterByKeyword } from '../shared/gemini.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const POLL_MS = 10_000
const STORE_API = 'https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInPolygon'
const MAX_PAGES = 50 // 폴리곤 하나당 최대 5만 건

// 상가정보 업종 코드 — 음식(I2) 전체에서 주점(I211)을 빼고, 편의점(G20405)을 더한다
const STORE_QUERIES = [{ indsLclsCd: 'I2' }, { indsSclsCd: 'G20405' }]
const EXCLUDED_MIDDLE = new Set(['I211'])

const KIND_DESC = {
  admin: '행정구역(admin) — 경계 폴리곤이 필요',
  road: '도로(road) — 도로 선 좌표가 필요',
  poi: '지명(poi) — 중심 좌표가 필요',
}

// ---------- Aside ----------

export async function runAside(region) {
  const template = await readFile(path.join(HERE, 'aside-prompt.md'), 'utf8')
  const prompt = template
    .replaceAll('{{NAME}}', region.name)
    .replaceAll('{{KIND}}', region.kind)
    .replaceAll('{{KIND_DESC}}', KIND_DESC[region.kind])

  const bin = process.env.ASIDE_BIN || 'aside'
  const timeout = Number(process.env.ASIDE_TIMEOUT_SEC || 600) * 1000
  // .cmd · .bat 은 셸을 거쳐야 실행되므로 줄바꿈 · 따옴표를 정리해 한 줄로 넘긴다
  const viaShell = /\.(cmd|bat)$/i.test(bin)
  const arg = viaShell ? `"${prompt.replace(/\r?\n/g, ' ').replace(/"/g, "'")}"` : prompt

  const stdout = await new Promise((resolve, reject) => {
    execFile(bin, [arg], { timeout, maxBuffer: 50 * 1024 * 1024, shell: viaShell, windowsHide: true },
      (err, out, errOut) => {
        if (err) reject(new Error(`aside 실행 실패: ${err.message}\n${String(errOut).slice(0, 500)}`))
        else resolve(out)
      })
  })

  // 디버깅용으로 원문을 남긴다
  await mkdir(path.join(HERE, 'out'), { recursive: true })
  await writeFile(path.join(HERE, 'out', `${region.id}.txt`), stdout)
  return parseAsideOutput(stdout)
}

export function parseAsideOutput(text) {
  const marked = text.match(/<<<JSON\s*([\s\S]*?)\s*JSON>>>/g)
  const candidate = marked
    ? marked.at(-1).replace(/<<<JSON|JSON>>>/g, '')
    : text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)
  try {
    return JSON.parse(candidate)
  } catch {
    throw new Error(`Aside 출력에서 JSON 을 찾지 못했습니다: ${text.slice(-300)}`)
  }
}

// ---------- 상가정보 API ----------

function publicDataKey() {
  const key = process.env.PUBLIC_DATA_KEY
  if (!key) throw new Error('PUBLIC_DATA_KEY 가 설정되지 않았습니다')
  // Encoding 키를 넣어도 되게 한 번 풀어 둔다 (URLSearchParams 가 다시 인코딩한다)
  return key.includes('%') ? decodeURIComponent(key) : key
}

async function fetchStorePage(wkt, filter, pageNo) {
  const params = new URLSearchParams({
    serviceKey: publicDataKey(),
    key: wkt,
    numOfRows: '1000',
    pageNo: String(pageNo),
    type: 'json',
    ...filter,
  })
  // 공공데이터 서버가 가끔 연결 시간 초과를 내므로 3번까지 다시 시도한다
  let res, text
  for (let attempt = 1; ; attempt++) {
    try {
      res = await fetch(`${STORE_API}?${params}`)
      text = await res.text()
      break
    } catch (e) {
      if (attempt >= 3) throw new Error(`상가정보 API 연결 실패: ${e.cause?.code ?? e.message}`)
      await new Promise((r) => setTimeout(r, 2000 * attempt))
    }
  }
  let data
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error(`상가정보 API 응답 오류 (${res.status}): ${text.slice(0, 200)}`)
  }
  const code = data.header?.resultCode
  if (code === '03') return { items: [], total: 0 } // 데이터 없음
  if (code !== '00') throw new Error(`상가정보 API 오류 ${code}: ${data.header?.resultMsg}`)
  return { items: data.body?.items ?? [], total: Number(data.body?.totalCount ?? 0) }
}

export async function fetchStores(polygon) {
  const byId = new Map()
  for (const wkt of toQueryWkts(polygon)) {
    for (const filter of STORE_QUERIES) {
      for (let page = 1; page <= MAX_PAGES; page++) {
        const { items, total } = await fetchStorePage(wkt, filter, page)
        for (const s of items) byId.set(s.bizesId, s)
        if (page * 1000 >= total || items.length === 0) break
      }
    }
  }
  return [...byId.values()]
    .filter((s) => !EXCLUDED_MIDDLE.has(s.indsMclsCd))
    .filter((s) => insideRegion(polygon, Number(s.lon), Number(s.lat)))
    .map((s) => ({
      place_key: s.bizesId,
      name: s.brchNm ? `${s.bizesNm} ${s.brchNm}` : s.bizesNm,
      category: s.indsSclsNm,
      address: s.rdnmAdr || s.lnoAdr,
      lat: Number(s.lat),
      lng: Number(s.lon),
    }))
}

// ---------- 구획 하나 처리 ----------

async function collect(region, geo) {
  const { polygon, note } = buildRegionPolygon(region.kind, geo)
  let places = await fetchStores(polygon)
  if (region.keyword) {
    const keep = new Set(await filterByKeyword(places, region.keyword))
    places = places.filter((_, i) => keep.has(i))
  }
  return { polygon, note, places, center: centerOf(polygon) }
}

async function processOne(db) {
  const { data: pending, error } = await db
    .from('regions').select('*').eq('status', 'pending')
    .order('created_at').limit(1)
  if (error) throw error
  if (!pending.length) return false

  // 다른 수집기가 먼저 가져가지 않았을 때만 차지한다
  const { data: claimed } = await db
    .from('regions').update({ status: 'collecting', error: null })
    .eq('id', pending[0].id).eq('status', 'pending').select()
  if (!claimed?.length) return true
  const region = claimed[0]
  console.log(`[수집 시작] ${region.name} (${region.kind}${region.keyword ? ` · ${region.keyword}` : ''})`)

  try {
    const geo = await runAside(region)
    const { polygon, note, places, center } = await collect(region, geo)

    const { error: delError } = await db.from('restaurants').delete().eq('region_id', region.id)
    if (delError) throw delError
    for (let i = 0; i < places.length; i += 500) {
      const rows = places.slice(i, i + 500).map((p) => ({ ...p, region_id: region.id }))
      const { error: insError } = await db.from('restaurants').insert(rows)
      if (insError) throw insError
    }
    const { error: doneError } = await db.from('regions').update({
      status: 'done', polygon, center_lat: center.lat, center_lng: center.lng,
      error: note, collected_at: new Date().toISOString(),
    }).eq('id', region.id)
    if (doneError) throw doneError
    console.log(`[수집 완료] ${region.name}: 업장 ${places.length}곳${note ? ` (${note})` : ''}`)
  } catch (e) {
    console.error(`[수집 실패] ${region.name}: ${e.message}`)
    await db.from('regions').update({ status: 'failed', error: e.message.slice(0, 500) }).eq('id', region.id)
  }
  return true
}

// ---------- 실행 ----------

async function main() {
  const args = process.argv.slice(2)

  if (args[0] === '--dry') {
    const geo = JSON.parse(await readFile(args[1], 'utf8'))
    const region = { name: geo.name, kind: geo.kind, keyword: args[2] ?? '' }
    const { places, note, center } = await collect(region, geo)
    console.log(`구획 ${region.name} (${region.kind}) 중심 ${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}${note ? ` — ${note}` : ''}`)
    console.log(`업장 ${places.length}곳`)
    const byCat = {}
    for (const p of places) byCat[p.category] = (byCat[p.category] ?? 0) + 1
    console.log(Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 15))
    return
  }

  const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  })
  // 지난번에 수집 도중 꺼졌던 구획은 다시 대기로 돌린다
  await db.from('regions').update({ status: 'pending' }).eq('status', 'collecting')

  if (args.includes('--once')) {
    if (!(await processOne(db))) console.log('대기 중인 요청이 없습니다')
    return
  }
  console.log('수집기 실행 중 — Ctrl+C 로 종료')
  for (;;) {
    try {
      while (await processOne(db)) {}
    } catch (e) {
      console.error('[오류]', e.message)
    }
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

// 직접 실행할 때만 돈다 (다른 파일에서 import 할 때는 실행하지 않음)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
