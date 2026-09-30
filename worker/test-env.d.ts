// Types the `env` exported by "cloudflare:test" with this Worker's bindings.
import type { Env as WorkerEnv } from "./env";

declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {}
  }
}
