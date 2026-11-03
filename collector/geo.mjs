// 구획 폴리곤 계산 — 좌표는 모두 [경도, 위도] (GeoJSON 규칙)
import * as turf from '@turf/turf'

export const ROAD_HALF_WIDTH_M = 50 // 도로 양쪽으로 넓힐 거리
export const POI_RADIUS_M = 500 // 지명 중심 반경
const ADMIN_FALLBACK_RADIUS_M = 700 // 행정구역 경계를 못 받았을 때 대신 쓸 반경

const isLngLat = (p) =>
  Array.isArray(p) && p.length >= 2 && Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90 &&
  // 한국 주변 좌표인지 확인 (위경도 순서가 뒤바뀐 경우를 잡는다)
  p[0] > 120 && p[0] < 135 && p[1] > 30 && p[1] < 45

// Aside 결과 → { polygon(GeoJSON geometry), note }
export function buildRegionPolygon(kind, geo) {
  if (kind === 'admin') {
    const g = geo.polygon
    if (g && ['Polygon', 'MultiPolygon'].includes(g.type) && turf.coordAll(g).every(isLngLat)) {
      return { polygon: g, note: null }
    }
    if (isLngLat(geo.center)) {
      const circle = turf.circle(geo.center, ADMIN_FALLBACK_RADIUS_M / 1000, { steps: 48 })
      return { polygon: circle.geometry, note: `경계를 받지 못해 반경 ${ADMIN_FALLBACK_RADIUS_M}m 원으로 대체` }
    }
    throw new Error('행정구역 경계와 중심 좌표를 모두 받지 못했습니다')
  }

  if (kind === 'road') {
    // line: [[lng,lat],...] 또는 여러 구간 [[[lng,lat],...], ...]
    const raw = geo.line
    const parts = Array.isArray(raw?.[0]?.[0]) ? raw : raw ? [raw] : []
    const lines = parts.map((l) => l.filter(isLngLat)).filter((l) => l.length >= 2)
    if (lines.length) {
      const buffered = turf.buffer(turf.multiLineString(lines), ROAD_HALF_WIDTH_M / 1000)
      return { polygon: buffered.geometry, note: null }
    }
    throw new Error('도로 선 좌표를 받지 못했습니다')
  }

  // poi
  if (isLngLat(geo.center)) {
    return { polygon: turf.circle(geo.center, POI_RADIUS_M / 1000, { steps: 48 }).geometry, note: null }
  }
  throw new Error('지명 중심 좌표를 받지 못했습니다')
}

export function centerOf(polygon) {
  const [lng, lat] = turf.centroid(polygon).geometry.coordinates
  return { lat, lng }
}

// 상가정보 API 폴리곤 검색용 WKT 목록.
// 주소 길이를 줄이려고 단순화하되, 경계 근처 업장이 빠지지 않게 100m 넓힌 뒤 단순화한다.
// 정확한 안/밖 판정은 insideRegion 으로 따로 한다.
export function toQueryWkts(polygon) {
  const widened = turf.buffer(turf.feature(polygon), 0.1)
  let simple = widened
  for (const tolerance of [0.0002, 0.0005, 0.001, 0.002, 0.004]) {
    simple = turf.simplify(widened, { tolerance, highQuality: true })
    if (turf.coordAll(simple).length <= 150) break
  }
  const g = simple.geometry
  const outerRings = g.type === 'Polygon' ? [g.coordinates[0]] : g.coordinates.map((p) => p[0])
  return outerRings.map(
    (ring) => `POLYGON((${ring.map(([x, y]) => `${x.toFixed(6)} ${y.toFixed(6)}`).join(', ')}))`,
  )
}

export function insideRegion(polygon, lng, lat) {
  return turf.booleanPointInPolygon(turf.point([lng, lat]), polygon)
}
