import { createInterface } from "node:readline";
import { Terrain } from "./pilot/terrain.mjs";
import { Tactics } from "./pilot/tactics.mjs";

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
let pilot,
  latest,
  scheduled = false,
  ended = false;
function respond(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}
function decide() {
  scheduled = false;
  if (ended || !latest || !pilot) return;
  const observation = latest;
  latest = undefined;
  respond(pilot.act(observation));
}
input.on("line", (line) => {
  if (ended || !line.trim()) return;
  const message = JSON.parse(line);
  if (message.type === "hello") {
    pilot = new Tactics(message, new Terrain(message.map.dir));
    respond({ type: "ready", name: "Switchback" });
  } else if (message.type === "end") {
    ended = true;
    latest = undefined;
    input.close();
  } else if (message.type === "obs") {
    latest = message;
    if (!scheduled) {
      scheduled = true;
      setImmediate(decide);
    }
  }
});
