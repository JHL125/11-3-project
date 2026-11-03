import { useCallback, useEffect, useState } from 'react'
import { supabase, fetchAll } from './supabase.js'
import MapView from './MapView.jsx'

const KIND_LABEL = { admin: '행정구역', road: '도로', poi: '지명' }
const STATUS_LABEL = {
  pending: '수집 대기 중 — 수집기 PC가 켜져 있어야 진행됩니다',
  collecting: '수집 중…',
  failed: '수집 실패',
}

// 주소창 #구획ID 로 공유 · 새로고침 시 같은 구획을 다시 연다
const regionIdFromHash = () => window.location.hash.slice(1) || null

export default function App() {
  const [query, setQuery] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [message, setMessage] = useState('')
  const [regions, setRegions] = useState([])
  const [regionId, setRegionId] = useState(regionIdFromHash)
  const [restaurants, setRestaurants] = useState([])
  const [statusMap, setStatusMap] = useState({})
  const [busyKey, setBusyKey] = useState(null)

  const region = regions.find((r) => r.id === regionId) ?? null

  // 최근 구획 목록 + 구획 상태 실시간 반영
  useEffect(() => {
    if (!supabase) return
    supabase
      .from('regions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(50)
      .then(({ data, error }) => (error ? setMessage(error.message) : setRegions(data)))

    const channel = supabase
      .channel('regions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'regions' }, ({ new: row }) => {
        if (!row?.id) return
        setRegions((prev) => [row, ...prev.filter((r) => r.id !== row.id)])
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  // 다른 사용자가 누른 비플페이 상태 실시간 반영
  useEffect(() => {
    if (!supabase) return
    const channel = supabase
      .channel('bipl_status')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'bipl_status' }, ({ new: row }) => {
        if (row?.place_key) setStatusMap((prev) => ({ ...prev, [row.place_key]: row.status }))
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [])

  useEffect(() => {
    if (regionId) window.history.replaceState(null, '', `#${regionId}`)
  }, [regionId])

  // 공유 링크를 붙여 넣는 등 주소의 #구획ID 만 바뀌어도 그 구획을 연다
  useEffect(() => {
    const onHash = () => setRegionId(regionIdFromHash())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 구획 수집이 끝나면 업장과 비플페이 상태를 불러온다
  const regionReady = region?.status === 'done'
  useEffect(() => {
    if (!supabase || !regionId || !regionReady) {
      setRestaurants([])
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const rows = await fetchAll(() =>
          supabase.from('restaurants').select('*').eq('region_id', regionId).order('id'),
        )
        const keys = rows.map((r) => r.place_key)
        const statuses = {}
        for (let i = 0; i < keys.length; i += 150) {
          const { data, error } = await supabase
            .from('bipl_status')
            .select('place_key,status')
            .in('place_key', keys.slice(i, i + 150))
          if (error) throw error
          for (const s of data) statuses[s.place_key] = s.status
        }
        if (cancelled) return
        setRestaurants(rows)
        setStatusMap((prev) => ({ ...prev, ...statuses }))
      } catch (e) {
        if (!cancelled) setMessage(`불러오기 실패: ${e.message}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [regionId, regionReady])

  async function handleSubmit(e) {
    e.preventDefault()
    if (!query.trim()) return
    setSubmitting(true)
    setMessage('')
    try {
      const res = await fetch('/api/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `요청 실패 (${res.status})`)
      setRegions((prev) => [body.region, ...prev.filter((r) => r.id !== body.region.id)])
      setRegionId(body.region.id)
    } catch (err) {
      setMessage(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  const handleVote = useCallback(async (placeKey, status) => {
    setBusyKey(placeKey)
    const { error } = await supabase.rpc('set_bipl', { p_place_key: placeKey, p_status: status })
    setBusyKey(null)
    if (error) setMessage(`저장 실패: ${error.message}`)
    else setStatusMap((prev) => ({ ...prev, [placeKey]: status }))
  }, [])

  if (!supabase) {
    return (
      <div className="setup">
        <h1>비플페이 식당 지도</h1>
        <p>
          Supabase 설정이 없습니다. <code>.env.example</code>을 <code>.env.local</code>로 복사해 값을 채운 뒤
          다시 실행해 주세요.
        </p>
      </div>
    )
  }

  const yesCount = restaurants.filter((r) => statusMap[r.place_key] === 'yes').length

  return (
    <div className="app">
      <header className="bar">
        <h1>비플페이 식당 지도</h1>
        <form onSubmit={handleSubmit} className="search">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="예: 테헤란로 · 역삼1동 · 강남역 근처 국밥집"
            maxLength={100}
          />
          <button type="submit" disabled={submitting}>
            {submitting ? '해석 중…' : '지도 만들기'}
          </button>
        </form>
        {regions.length > 0 && (
          <div className="chips">
            {regions.slice(0, 12).map((r) => (
              <button
                key={r.id}
                className={r.id === regionId ? 'chip active' : 'chip'}
                onClick={() => setRegionId(r.id)}
                title={r.query}
              >
                {r.name}
                {r.keyword && ` · ${r.keyword}`}
                {r.status !== 'done' && ' ⏳'}
              </button>
            ))}
          </div>
        )}
      </header>

      <div className="status-line">
        {message && <span className="error">{message}</span>}
        {!message && region && (
          <span>
            <b>{region.name}</b> ({KIND_LABEL[region.kind]}
            {region.keyword && ` · ${region.keyword}`}){' '}
            {region.status === 'done'
              ? `— 업장 ${restaurants.length}곳 · 비플페이 가능 ${yesCount}곳${region.error ? ` (${region.error})` : ''}`
              : `— ${STATUS_LABEL[region.status]}${region.error ? `: ${region.error}` : ''}`}
          </span>
        )}
        {!message && !region && <span>구획 이름이나 "강남역 근처 국밥집"처럼 입력해 보세요.</span>}
      </div>

      <MapView
        region={region}
        restaurants={restaurants}
        statusMap={statusMap}
        onVote={handleVote}
        busyKey={busyKey}
      />

      <div className="legend">
        <span><i className="pin pin-yes" /> 가능</span>
        <span><i className="pin pin-no" /> 불가능</span>
        <span><i className="pin" /> 미확인</span>
      </div>
    </div>
  )
}
