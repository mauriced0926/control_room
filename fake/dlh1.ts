// The fake's default site: DLH-1 exactly as its hello describes it in research/fixtures (route,
// vehicles, loop length), plus the notice length every captured closure had (120 s). This is the
// only file in fake/ allowed this site's names and numbers (test/source-rules.test.ts).
import type { SiteConfig } from './model.ts';

export const DLH1: SiteConfig = {
  site_id: 'DLH-1',
  vehicles: ['HT-01', 'HT-02', 'HT-03', 'HT-04', 'HT-05', 'HT-06', 'HT-07', 'HT-08', 'HT-09', 'HT-10', 'HT-11', 'HT-12'],
  route: [
    { segment_id: 'SEG-BAY', zone_id: 'BAY', length_m: 80.0, kind: 'bay', start_m: 0.0 },
    { segment_id: 'SEG-DEC-1', zone_id: 'DECLINE', length_m: 250.0, kind: 'transit', start_m: 80.0 },
    { segment_id: 'SEG-DEC-2', zone_id: 'DECLINE', length_m: 250.0, kind: 'transit', start_m: 330.0 },
    { segment_id: 'SEG-L4N-1', zone_id: 'L4_NORTH', length_m: 200.0, kind: 'transit', start_m: 580.0 },
    { segment_id: 'SEG-DRAW-12', zone_id: 'DRAW_12', length_m: 60.0, kind: 'load', start_m: 780.0 },
    { segment_id: 'SEG-L4S-1', zone_id: 'L4_SOUTH', length_m: 200.0, kind: 'transit', start_m: 840.0 },
    { segment_id: 'SEG-INC-1', zone_id: 'INCLINE', length_m: 250.0, kind: 'transit', start_m: 1040.0 },
    { segment_id: 'SEG-INC-2', zone_id: 'INCLINE', length_m: 250.0, kind: 'transit', start_m: 1290.0 },
    { segment_id: 'SEG-TIP-1', zone_id: 'TIP', length_m: 60.0, kind: 'dump', start_m: 1540.0 },
  ],
  loop_length_m: 1600.0,
  noticeMs: 120_000,
};
