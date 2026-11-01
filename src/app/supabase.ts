// Supabase クライアントのシングルトン（cookmaker と同じ）。
// このモジュールは real.ts / auth.ts / api.ts からのみ import する
// （domtest はフェイク Api を注入するため、ここに依存しない）。
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;

export function getSupabase(): SupabaseClient {
  if (client) return client;
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  const url = env?.PUBLIC_SUPABASE_URL;
  const key = env?.PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "PUBLIC_SUPABASE_URL / PUBLIC_SUPABASE_ANON_KEY が未設定です。.env を用意してください（.env.example 参照）",
    );
  }
  client = createClient(url, key);
  return client;
}
