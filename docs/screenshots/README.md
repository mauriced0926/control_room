# Overview screenshots

The Overview in the fixture player, at each recording's telling moment. Taken by `npm run screenshots`
(`player/shoot.ts`), which finds each moment from the data (a bookmark the player derives by
replaying the fixture) and renders it in the locally installed Google Chrome, headless, through
playwright-core. 1440 px wide, full page. Each was looked at before it was described here.

Every shot is paused, so each says "Paused. Fixture time has stopped". Most fixtures were cut from the
middle of a run and carry no `hello`, so they are replayed on this site's route with every zone open
at the start, and trucks the recording never mentions show as "never reported" and share one dotted
whole-loop bar. Only `silent-truck` and `link-drop-in-notice` kept heartbeats; for the rest the site
link reads "not in this recording" rather than "down".

| File | Fixture, time | What it shows |
|---|---|---|
| `01-frozen-truck.png` | frozen-truck, +0:43 | HT-10 reports TRAMMING but has not moved: a cross-hatched pink bar labelled "data frozen, last moved 23 s ago", from TIP round the loop end into BAY, with a hollow circle at its last believable position. Table: "contradicted", "last seen TIP; could be in BAY, INCLINE, TIP". |
| `02-frozen-truck-loading-contrast.png` | frozen-truck, end (+6:17) | HT-05 LOADING also sends identical messages, at speed 0: a solid "live" chip marked "loading". HT-10, quiet by now, is "silent 4 min 57 s", hatched over the whole loop. |
| `03-silent-truck-old.png` | silent-truck, +0:08 | HT-03 is "old 2 s": a grey chip with a dashed edge and its age, "◐ old 2 s" in the table. Site link up, heartbeat 0 s ago. |
| `04-silent-truck.png` | silent-truck, +0:35 | HT-03 "silent 30 s": a grey hatched bar across part of DECLINE with its last position circled; table "last seen DECLINE; could be in DECLINE". Site link still up (heartbeat 1 s ago). |
| `05-link-drop-in-notice.png` | link-drop-in-notice, +0:22 | Site link DOWN for 20 s: red indicator, a banner ("Everything below is at least that old; ages keep counting") and the whole picture greyed. DRAW_12 UNSURE, "Radio the shot firer to hold the shot.", "closes in 1:39". The greying also takes the amber out of UNSURE; its word, "?", stripes and dashed edge remain. |
| `06-two-zones-closing.png` | two-zones-closing, +0:05 | DRAW_12 "closes in 1:52" and TIP "closes in 1:22": two rows, two countdowns, both UNSURE because no truck has reported. Both bands amber with CLOSING and the countdown. |
| `07-two-zones-one-closed.png` | two-zones-closing, +1:29 | TIP "closed 0:03 ago", its band hatched red with CLOSED; DRAW_12 still "closes in 0:27". Every row's zone cell carries "DRAW_12 CLOSING, TIP CLOSED". |
| `08-weak-pack-wont-finish-lap.png` | weak-pack, +0:26 | HT-06 first row: "won't finish its lap: return to bay now" under its 41.4 %, and the full warning in "Why here". No drain-rate flag yet at this moment. The fixture is thinned (other trucks at 0.2 Hz), so the rest show "old 2 s" between their messages, which is true of the data. |
| `09-weak-pack-cannot-reach-bay.png` | weak-pack, +3:14 | All four data states at once: HT-06 live, "draining 5.0× faster than the fleet" and "may not reach the bay on this charge"; HT-10 contradicted (pink cross-hatch wrapping the loop end); HT-03 "silent 26 s" (grey hatch); the rest old (dashed grey chips). HT-12's fraction flag is visible too. |
| `10-weak-pack-depleted.png` | weak-pack, +8:31 | HT-06 BATTERY_DEPLETED in INCLINE: chip with a red edge and "⚠ fault"; first row, "faulted (BATTERY_DEPLETED)", "depleted: needs a tow". HT-11 second, faulted HYD_PRESSURE_LOW. Chips near both ends of the line are pulled in, with angled connectors to their true positions. |
| `11-fractional-soc.png` | fractional-soc, +0:08 | HT-12's charge "0.8187 (as sent)" with "looks like a fraction, not a percentage; shown as sent, not scaled". |
| `12-reverse-exit-zone.png` | reverse-exit-zone, +0:23 | HT-05 under EXIT_ZONE: chip "◀ reversing" in DECLINE, state "TRAMMING · EXIT_ZONE · reversing", with HT-07 just behind it going forward. "Last command" is a placeholder until the command registry exists. |
| `13-seq-reset.png` | seq-reset, +0:13 | HT-01 a few seconds after its controller restarted (seq 887 to 1): still a live chip on L4_SOUTH. The restart note itself is not on the Overview: it belongs in the attention tray or truck detail, not built yet. |

Not shown, because no fixture has it: CLEAR or NOT CLEAR in the clearance panel (the two fixtures with
a closing zone carry no telemetry), the service disconnected (tested in `test/ui.browser.ts` instead),
and command or e-stop states (they need the command registry).
