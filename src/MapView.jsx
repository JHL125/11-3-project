import { useEffect, useMemo } from 'react'
import { MapContainer, TileLayer, GeoJSON, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'

const SEOUL = [37.5665, 126.978]

// 상태별 마커 모양: yes = 깜빡이는 형광 핑크 테두리, no = 회색, 없음 = 색 없음
const ICONS = {
  yes: L.divIcon({ className: 'pin pin-yes', iconSize: [18, 18] }),
  no: L.divIcon({ className: 'pin pin-no', iconSize: [14, 14] }),
  none: L.divIcon({ className: 'pin', iconSize: [14, 14] }),
}

// 구획이 바뀌면 폴리곤에 맞춰 화면을 옮긴다
function FitToRegion({ region }) {
  const map = useMap()
  useEffect(() => {
    if (!region?.polygon) return
    const bounds = L.geoJSON(region.polygon).getBounds()
    if (!bounds.isValid()) return
    // 첫 화면에서는 지도 크기가 아직 0일 수 있어, 크기를 다시 잰 뒤 맞춘다
    const id = setTimeout(() => {
      map.invalidateSize()
      map.fitBounds(bounds, { padding: [24, 24] })
    }, 0)
    return () => clearTimeout(id)
  }, [region?.id, region?.polygon, map])
  return null
}

export default function MapView({ region, restaurants, statusMap, onVote, busyKey }) {
  const markers = useMemo(
    () =>
      restaurants.map((r) => {
        const status = statusMap[r.place_key]
        return (
          <Marker
            key={r.id}
            position={[r.lat, r.lng]}
            icon={ICONS[status] ?? ICONS.none}
            // 가능한 집이 다른 마커에 가려지지 않게 위로 올린다
            zIndexOffset={status === 'yes' ? 1000 : 0}
          >
            <Popup>
              <div className="popup">
                <strong>{r.name}</strong>
                <span className="popup-meta">{r.category}</span>
                <span className="popup-meta">{r.address}</span>
                <div className="popup-buttons">
                  <button
                    className={status === 'yes' ? 'vote vote-yes active' : 'vote vote-yes'}
                    disabled={busyKey === r.place_key}
                    onClick={() => onVote(r.place_key, 'yes')}
                  >
                    비플페이 가능
                  </button>
                  <button
                    className={status === 'no' ? 'vote vote-no active' : 'vote vote-no'}
                    disabled={busyKey === r.place_key}
                    onClick={() => onVote(r.place_key, 'no')}
                  >
                    불가능
                  </button>
                </div>
              </div>
            </Popup>
          </Marker>
        )
      }),
    [restaurants, statusMap, onVote, busyKey],
  )

  return (
    <MapContainer center={SEOUL} zoom={12} className="map">
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
      />
      {region?.polygon && (
        <GeoJSON
          key={region.id}
          data={region.polygon}
          style={{ color: '#3b5bdb', weight: 2, fillOpacity: 0.06 }}
          interactive={false}
        />
      )}
      <FitToRegion region={region} />
      {markers}
    </MapContainer>
  )
}
