import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env, has } from "../env.js";

let _sb: SupabaseClient | null = null;

/** Null when Supabase is not configured - the engine runs in memory and says so at boot. */
export function sb(): SupabaseClient | null {
  if (!has.supabase()) return null;
  if (!_sb) {
    _sb = createClient(env.supabaseUrl, env.supabaseKey, { auth: { persistSession: false } });
  }
  return _sb;
}
