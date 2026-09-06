import { PostgresStore } from "../src/storage/postgres.js";
import { fold } from "../src/core/engine.js";
import { initialState, stateHash } from "../src/core/state.js";
import { fileURLToPath } from "node:url";

const store = new PostgresStore("postgresql://postgres@127.0.0.1:54329/pothos_first");
const params = await store.getParams();
const origin = typeof params["state_origin_ts"] === "number" ? params["state_origin_ts"] : 0;
const all = await store.loadEvents();
console.log("events:", all.map(e => `${e.kind}@${e.ts - origin}ms`).join(" | "));
console.log("origin:", new Date(origin).toISOString(), " latest event t:", new Date(all[all.length-1]!.ts).toISOString());
const full = fold(all, all[all.length-1]!.ts, { from: initialState(origin, 0x50544853) });

const snap = await store.latestSnapshot();
console.log("snapshot t:", snap ? new Date(snap.ts).toISOString() : "none", " lastEventId:", snap?.lastEventId);
const snapState = snap!.state;
console.log("full replay hash:", stateHash(full.state));
console.log("snapshot  hash:", stateHash(snapState));
console.log("live t (snapshot):", snapState.t, " full t:", full.state.t);

const can = (v: unknown): string => {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(can).join(",") + "]";
  const e = Object.entries(v as Record<string, unknown>).sort(([a],[b]) => a < b ? -1 : 1);
  return "{" + e.map(([k,x]) => JSON.stringify(k) + ":" + can(x)).join(",") + "}";
};
const a = can(snapState), b = can(full.state);
let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
console.log("首个分歧 @", i, ":");
console.log("snap :", a.slice(Math.max(0,i-70), i+90));
console.log("full :", b.slice(Math.max(0,i-70), i+90));
await store.close();
