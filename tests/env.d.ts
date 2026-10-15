import type { D1Migration } from "cloudflare:test";
import type { WorkerEnv } from "../worker/types.js";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv { TEST_MIGRATIONS: D1Migration[] }
    interface GlobalProps { mainModule: typeof import("../worker/index.js") }
  }
}
