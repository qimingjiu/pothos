/** Explicit legacy-drift recovery. Original events and snapshots remain intact. */
import { createHash } from "node:crypto";
import { fold } from "../core/engine.js";
import { initialState, stateHash } from "../core/state.js";
import { rendererVersion } from "../render/renderer.js";
import { assembleParams } from "../core/params.js";
import type { EventStore } from "../storage/types.js";

export async function previewRecovery(store: EventStore) {
  const origin = (await store.getParams())["state_origin_ts"];
  if (typeof origin !== "number" || !Number.isSafeInteger(origin)) throw new Error("missing/invalid state_origin_ts; cannot infer historical origin");
  const snapshot = await store.latestSnapshot();
  if (!snapshot) throw new Error("no snapshot to recover; normal boot can replay events");
  const events = await store.loadEvents();
  const lastEventId = events.at(-1)?.id ?? 0;
  const state = fold(events, snapshot.state.t, { from: initialState(origin, 0x50544853) }).state;
  const snapshotHash = stateHash(snapshot.state);
  const replayHash = stateHash(state);
  const token = createHash("sha256").update(JSON.stringify({ snapshotId: snapshot.id, snapshotHash, replayHash, lastEventId })).digest("hex");
  return { token, snapshotId: snapshot.id, snapshotHash, replayHash, lastEventId, recoveryTs: state.t, state };
}

/** Caller must hold the singleton lock and keep the live engine stopped. */
export async function applyRecovery(store: EventStore, expectedToken: string, reason: string) {
  const plan = await previewRecovery(store);
  if (plan.token !== expectedToken) throw new Error("recovery preview changed; inspect a fresh preview");
  if (!reason.trim()) throw new Error("recovery reason is required");
  await store.appendBenchRun({ ts: Date.now(), benchKind: "snapshot_recovery", axis: null,
    result: { token: plan.token, snapshotId: plan.snapshotId, snapshotHash: plan.snapshotHash,
      replayHash: plan.replayHash, lastEventId: plan.lastEventId, reason }, modelVersion: "runtime-audit-v2" });
  // Persist this boundary too, otherwise the first post-recovery tick would split
  // the numerical integrator differently from a full replay.
  const marker = await store.appendEvent({ kind: "tick", ts: plan.recoveryTs,
    payload: { foldedAt: plan.recoveryTs, recovery: plan.token }, idempotencyKey: `recovery-${plan.token}` });
  if (!marker) throw new Error("recovery marker already exists; inspect a fresh preview");
  await store.saveSnapshot(plan.state, marker.id, rendererVersion(assembleParams(plan.state.paramOverrides).renderBlacklistExtra));
  return { token: plan.token, stateHash: plan.replayHash, lastEventId: marker.id };
}
