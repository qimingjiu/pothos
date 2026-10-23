import { PostgresStore } from "../storage/postgres.js";
import { applyRecovery, previewRecovery } from "./recovery.js";

async function main() {
  const store = PostgresStore.fromEnv();
  if (!store) throw new Error("POTHOS_PG_URL is required; recovery never targets memory storage");
  try {
    if (!await store.acquireSingletonLock()) throw new Error("stop the live engine before recovery");
    const args = process.argv.slice(2);
    if (args.length === 0) {
      const { state: _state, ...preview } = await previewRecovery(store);
      console.log(JSON.stringify({ ...preview, mode: "preview", note: "No writes. Legacy unrecorded tick history cannot be reconstructed; apply selects canonical event replay." }, null, 2));
    } else if (args.length === 4 && args[0] === "--apply" && args[2] === "--reason") {
      console.log(JSON.stringify(await applyRecovery(store, args[1]!, args[3]!), null, 2));
    } else throw new Error('usage: npm run recover -- [--apply <preview-token> --reason "reason"]');
  } finally { await store.close(); }
}
main().catch(e => { console.error(e instanceof Error ? e.message : String(e)); process.exitCode = 1; });
