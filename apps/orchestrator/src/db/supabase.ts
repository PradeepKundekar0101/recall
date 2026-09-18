import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { WebSocket } from "ws";
import { env, has } from "../env.js";
import { log } from "../log.js";

let _sb: SupabaseClient | null = null;
let failed = false;

/**
 * Null when Supabase is not configured, or when constructing it failed - the
 * engine runs in memory and says so rather than taking the call down.
 *
 * The explicit realtime transport is not optional on Node 20. supabase-js builds
 * a RealtimeClient eagerly inside createClient, and realtime-js throws outright if
 * there is no native global WebSocket - which Node 20 does not have. That killed
 * the orchestrator on the first audit write.
 *
 * Upgrading to Node 22 would supply the global and is the wrong fix: Node 22's
 * global WebSocket silently drops the options argument, so the auth headers on the
 * Scribe and ElevenLabs sockets would vanish. Node 20 plus the `ws` package is the
 * combination where every socket in this project works, so Supabase is handed the
 * same implementation everything else already uses.
 *
 * Realtime itself is unused here; the consoles are fed by SSE straight off the
 * orchestrator's own bus.
 */
export function sb(): SupabaseClient | null {
  if (!has.supabase() || failed) return null;
  if (!_sb) {
    try {
      _sb = createClient(env.supabaseUrl, env.supabaseKey, {
        auth: { persistSession: false },
        realtime: { transport: WebSocket as unknown as never },
      });
    } catch (err) {
      failed = true;
      log.warn(`supabase unavailable, continuing in memory: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }
  return _sb;
}
