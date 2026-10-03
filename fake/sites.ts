// Other sites for the fake to serve (TESTING.md L0.S, used by L4.S): a different route, segment
// lengths, zone names and loop length; any number of trucks; any notice. The product must take all
// of it from hello and zone_event (CLAUDE.md invariant 7), so nothing here resembles DLH-1.
//
// The route starts mid-haul rather than at the bay, so the bay is not at 0 m, and one zone (RAMP)
// is split over two segments. BAY closing is switched on per day with faults.bayClosing.
import type { SiteConfig } from './model.ts';

export interface VariantOptions {
  trucks: number;    // L0.S: 7 and 20
  noticeMs: number;  // L0.S: 60 s
  siteId?: string;
}

export function siteVariant(o: VariantOptions): SiteConfig {
  const route = [
    { segment_id: 'K-HAUL-A', zone_id: 'HAUL_ROAD', length_m: 300.0, kind: 'transit', start_m: 0.0 },
    { segment_id: 'K-CRUSH', zone_id: 'CRUSHER', length_m: 45.0, kind: 'dump', start_m: 300.0 },
    { segment_id: 'K-RET', zone_id: 'RETURN_DRIFT', length_m: 210.0, kind: 'transit', start_m: 345.0 },
    { segment_id: 'K-PARK', zone_id: 'WORKSHOP', length_m: 55.0, kind: 'bay', start_m: 555.0 },
    { segment_id: 'K-RAMP-1', zone_id: 'RAMP', length_m: 180.0, kind: 'transit', start_m: 610.0 },
    { segment_id: 'K-RAMP-2', zone_id: 'RAMP', length_m: 160.0, kind: 'transit', start_m: 790.0 },
    { segment_id: 'K-FACE', zone_id: 'STOPE_7', length_m: 40.0, kind: 'load', start_m: 950.0 },
    { segment_id: 'K-HAUL-B', zone_id: 'HAUL_ROAD_B', length_m: 260.0, kind: 'transit', start_m: 990.0 },
  ];
  return {
    site_id: o.siteId ?? `KESTREL-${o.trucks}`,
    vehicles: Array.from({ length: o.trucks }, (_, i) => `K${String(i + 101)}`),
    route,
    loop_length_m: 1250.0,
    noticeMs: o.noticeMs,
  };
}
