// The fixture player, from the command line:
//   node player/main.ts [--fixture frozen-truck] [--port 8091]
// then open the printed address. Replays research/fixtures/ only; never connects to a gateway.
import { parseArgs } from 'node:util';
import { SystemClock } from '../src/clock.ts';
import { startPlayerServer } from './server.ts';

const { values } = parseArgs({
  options: {
    fixture: { type: 'string', default: 'frozen-truck' },
    port: { type: 'string', default: '8091' },
  },
});

const s = await startPlayerServer({ clock: new SystemClock(), fixture: values.fixture, port: Number(values.port) });
console.log(`Fixture player: ${s.url}  (fixture ${values.fixture}; replay only, nothing is sent)`);
