import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// 설정이 없으면 null — 화면에서 설정 안내를 띄운다
export const supabase = url && anonKey ? createClient(url, anonKey) : null

// Supabase 는 한 번에 최대 1000행이라 나눠서 모두 가져온다
export async function fetchAll(buildQuery, pageSize = 1000) {
  const rows = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) throw error
    rows.push(...data)
    if (data.length < pageSize) return rows
  }
}
