import { PostgresStore } from "../src/storage/postgres.js";
import { fold } from "../src/core/engine.js";
import { initialState, stateHash } from "../src/core/state.js";

const store = new PostgresStore("postgresql://postgres@127.0.0.1:54329/pothos_first");
const params = await store.getParams();
const origin = params["state_origin_ts"] as number;
const all = await store.loadEvents();
const snap = (await store.latestSnapshot())!;
const full = fold(all, snap.state.t, { from: initialState(origin, 0x50544853) });
console.log("对账口径：fold(all, snap.t =", new Date(snap.state.t).toISOString(), ")");
console.log("snapshot hash:", stateHash(snap.state));
console.log("full    hash:", stateHash(full.state));
if (stateHash(full.state) !== stateHash(snap.state)) {
  const can = (v: unknown): string => {
    if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
    if (Array.isArray(v)) return "[" + v.map(can).join(",") + "]";
    const e = Object.entries(v as Record<string, unknown>).sort(([a],[b]) => a < b ? -1 : 1);
    return "{" + e.map(([k,x]) => JSON.stringify(k) + ":" + can(x)).join(",") + "}";
  };
  const a = can(snap.state), b = can(full.state);
  let i = 0; while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++;
  console.log("首个分歧 @", i, ":");
  console.log("snap :", a.slice(Math.max(0,i-80), i+100));
  console.log("full :", b.slice(Math.max(0,i-80), i+100));
  console.log("snap lastAlert:", (snap.state as unknown as Record<string, unknown>)["lastAlertIntentAt"], " eventsSince:", (snap.state as unknown as Record<string, unknown>)["eventsSinceSnapshot"]);
}
await store.close();
