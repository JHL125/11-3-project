// Vercel 함수: POST /api/request { query }
// 입력을 Gemini 로 해석하고, 같은 구획이 있으면 그것을, 없으면 수집 대기 요청을 새로 만들어 돌려준다
import { createClient } from '@supabase/supabase-js'
import { parseQuery } from '../shared/gemini.js'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST 만 받습니다' })

  const query = String(req.body?.query ?? '').trim()
  if (!query) return res.status(400).json({ error: '구획 이름을 입력해 주세요' })
  if (query.length > 100) return res.status(400).json({ error: '입력이 너무 깁니다(100자 이하)' })

  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !serviceKey) return res.status(500).json({ error: '서버에 Supabase 설정이 없습니다' })
  const db = createClient(url, serviceKey, { auth: { persistSession: false } })

  let parsed
  try {
    parsed = await parseQuery(query)
  } catch (e) {
    return res.status(502).json({ error: `입력 해석 실패: ${e.message}` })
  }
  if (parsed.error) return res.status(422).json({ error: parsed.error })

  const { data: existing, error: findError } = await db
    .from('regions')
    .select('*')
    .eq('name', parsed.name)
    .eq('kind', parsed.kind)
    .eq('keyword', parsed.keyword)
    .maybeSingle()
  if (findError) return res.status(500).json({ error: findError.message })

  // 실패했던 구획은 다시 수집 대기로 돌린다
  if (existing?.status === 'failed') {
    const { data, error } = await db
      .from('regions')
      .update({ status: 'pending', error: null, query })
      .eq('id', existing.id)
      .select()
      .single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ region: data })
  }
  if (existing) return res.status(200).json({ region: existing })

  const { data, error } = await db
    .from('regions')
    .insert({ query, ...parsed })
    .select()
    .single()
  if (error) return res.status(500).json({ error: error.message })
  return res.status(201).json({ region: data })
}
