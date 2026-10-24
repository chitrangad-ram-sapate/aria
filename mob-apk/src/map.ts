// Delivery map: delivery points with their arrival circle, and the driver's latest position. One small interface,
// two providers chosen at build time (.env, see docs/geoproof.md):
//   VITE_MAP_PROVIDER=google + VITE_GOOGLE_MAPS_KEY=...  Google Maps (needs a Maps JavaScript API key with billing)
//   VITE_MAP_PROVIDER=osm (default)                        OpenStreetMap tiles through Leaflet, no key
//   VITE_MAP_PROVIDER=none                                 no map; the status list still works
// Only real coordinates are drawn. No road route is drawn: there is no routing service, and a straight line is not a road.
export type MapStop = { id: string; n: number; label: string; lat: number; lon: number; radius_m: number; done: boolean; current: boolean };
export type MapDriver = { lat: number; lon: number; acc_m: number; live: boolean; label: string };
export interface DeliveryMap {
  show(stops: MapStop[], driver: MapDriver | null): void;
  fitAll(): void;
  centerDriver(): void;
  centerStop(id: string): void;
  destroy(): void;
}

const env = (import.meta as any).env ?? {};
const GOOGLE_KEY: string = env.VITE_GOOGLE_MAPS_KEY ?? '';
export const MAP_PROVIDER: 'google' | 'osm' | 'none' = env.VITE_MAP_PROVIDER === 'none' ? 'none' : env.VITE_MAP_PROVIDER === 'google' && GOOGLE_KEY ? 'google' : 'osm';
export const MAP_NAME = MAP_PROVIDER === 'google' ? 'Google Maps' : MAP_PROVIDER === 'osm' ? 'OpenStreetMap' : '';

const COLORS = { stop: '#2563eb', current: '#ea580c', done: '#16a34a', live: '#1d4ed8', old: '#6b7280' };

/** A map in `el`, or null when maps are switched off or could not load (no internet, bad key). */
export async function createMap(el: HTMLElement, onStop?: (id: string) => void): Promise<DeliveryMap | null> {
  try {
    if (MAP_PROVIDER === 'osm') return await leafletMap(el, onStop);
    if (MAP_PROVIDER === 'google') return await googleMap(el, onStop);
  } catch { /* fall through: the caller shows the list only */ }
  return null;
}

async function leafletMap(el: HTMLElement, onStop?: (id: string) => void): Promise<DeliveryMap> {
  const L = (await import('leaflet')).default;
  await import('leaflet/dist/leaflet.css');
  // no animations: the page redraws while a reading arrives, and an animation running then breaks Leaflet
  const map = L.map(el, { zoomControl: true, attributionControl: true, zoomAnimation: false, fadeAnimation: false, markerZoomAnimation: false }).setView([20.6, 78.9], 5);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: '&copy; OpenStreetMap contributors' }).addTo(map);
  const layer = L.layerGroup().addTo(map);
  let gone = false;
  let stops: MapStop[] = [];
  let driver: MapDriver | null = null;
  const all = () => [...stops.map((s) => [s.lat, s.lon] as [number, number]), ...(driver ? [[driver.lat, driver.lon] as [number, number]] : [])];
  const api: DeliveryMap = {
    show(ss, d) {
      if (gone) return;
      stops = ss;
      driver = d;
      layer.clearLayers();
      for (const s of ss) {
        const color = s.done ? COLORS.done : s.current ? COLORS.current : COLORS.stop;
        L.circle([s.lat, s.lon], { radius: s.radius_m, color, weight: 2, fillOpacity: s.current ? 0.12 : 0.05 }).addTo(layer);
        L.marker([s.lat, s.lon], { icon: L.divIcon({ className: 'map-pin', html: `<span style="background:${color}">${s.n}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] }), title: s.label })
          .on('click', () => onStop?.(s.id)).bindTooltip(s.label).addTo(layer);
      }
      if (d) {
        const color = d.live ? COLORS.live : COLORS.old;
        if (d.acc_m > 0) L.circle([d.lat, d.lon], { radius: d.acc_m, color, weight: 1, dashArray: '4 4', fillOpacity: 0.08 }).addTo(layer);
        L.circleMarker([d.lat, d.lon], { radius: 8, color: '#fff', weight: 3, fillColor: color, fillOpacity: 1 }).bindTooltip(d.label).addTo(layer);
      }
    },
    fitAll() {
      if (gone || !el.isConnected) return;
      const pts = all();
      if (pts.length === 1) map.setView(pts[0], 16); else if (pts.length) map.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 16 });
    },
    centerDriver() { if (!gone && driver) map.setView([driver.lat, driver.lon], Math.max(map.getZoom(), 16)); },
    centerStop(id) { const s = stops.find((x) => x.id === id); if (!gone && s) map.setView([s.lat, s.lon], 16); },
    destroy() { if (!gone) { gone = true; map.remove(); } },
  };
  setTimeout(() => { if (!gone && el.isConnected) map.invalidateSize(); }, 50); // the box may get its size after the map is made
  return api;
}

let googleLoading: Promise<any> | null = null;
function loadGoogle(): Promise<any> {
  googleLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_KEY)}&v=weekly`;
    s.async = true;
    s.onload = () => ((window as any).google?.maps ? resolve((window as any).google.maps) : reject(new Error('maps')));
    s.onerror = () => { googleLoading = null; reject(new Error('maps')); };
    document.head.append(s);
  });
  return googleLoading;
}

async function googleMap(el: HTMLElement, onStop?: (id: string) => void): Promise<DeliveryMap> {
  const g = await loadGoogle();
  const map = new g.Map(el, { center: { lat: 20.6, lng: 78.9 }, zoom: 5, streetViewControl: false, mapTypeControl: false, fullscreenControl: false });
  let drawn: any[] = [];
  let stops: MapStop[] = [];
  let driver: MapDriver | null = null;
  const api: DeliveryMap = {
    show(ss, d) {
      stops = ss;
      driver = d;
      drawn.forEach((x) => x.setMap(null));
      drawn = [];
      for (const s of ss) {
        const color = s.done ? COLORS.done : s.current ? COLORS.current : COLORS.stop;
        drawn.push(new g.Circle({ map, center: { lat: s.lat, lng: s.lon }, radius: s.radius_m, strokeColor: color, strokeWeight: 2, fillColor: color, fillOpacity: s.current ? 0.12 : 0.05 }));
        const m = new g.Marker({ map, position: { lat: s.lat, lng: s.lon }, title: s.label, label: { text: String(s.n), color: '#fff' } });
        m.addListener('click', () => onStop?.(s.id));
        drawn.push(m);
      }
      if (d) {
        const color = d.live ? COLORS.live : COLORS.old;
        if (d.acc_m > 0) drawn.push(new g.Circle({ map, center: { lat: d.lat, lng: d.lon }, radius: d.acc_m, strokeColor: color, strokeWeight: 1, fillColor: color, fillOpacity: 0.08 }));
        drawn.push(new g.Marker({ map, position: { lat: d.lat, lng: d.lon }, title: d.label, icon: { path: g.SymbolPath.CIRCLE, scale: 8, fillColor: color, fillOpacity: 1, strokeColor: '#fff', strokeWeight: 3 } }));
      }
    },
    fitAll() {
      const b = new g.LatLngBounds();
      stops.forEach((s) => b.extend({ lat: s.lat, lng: s.lon }));
      if (driver) b.extend({ lat: driver.lat, lng: driver.lon });
      if (!b.isEmpty()) { map.fitBounds(b, 30); if (stops.length + (driver ? 1 : 0) === 1) map.setZoom(16); }
    },
    centerDriver() { if (driver) { map.setCenter({ lat: driver.lat, lng: driver.lon }); map.setZoom(Math.max(map.getZoom(), 16)); } },
    centerStop(id) { const s = stops.find((x) => x.id === id); if (s) { map.setCenter({ lat: s.lat, lng: s.lon }); map.setZoom(16); } },
    destroy() { drawn.forEach((x) => x.setMap(null)); el.replaceChildren(); },
  };
  return api;
}
