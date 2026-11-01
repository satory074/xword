// 認証（Google OAuth via Supabase Auth）。
import type { User } from "@supabase/supabase-js";
import type { AuthCtl, SessionInfo } from "../lib/types";
import { getSupabase } from "./supabase";
import { BASE } from "./ui";

function toSessionInfo(user: User): SessionInfo {
  const meta = (user.user_metadata ?? {}) as Record<string, string | undefined>;
  return {
    userId: user.id,
    displayName: meta.name ?? meta.full_name ?? user.email?.split("@")[0] ?? "ユーザー",
    avatarUrl: meta.avatar_url ?? meta.picture ?? null,
  };
}

export function realAuth(): AuthCtl {
  const sb = getSupabase();
  return {
    async getSession() {
      const { data } = await sb.auth.getSession();
      return data.session ? toSessionInfo(data.session.user) : null;
    },
    async signIn() {
      // GitHub Pages のプロジェクトページなので base path まで含めて戻す
      await sb.auth.signInWithOAuth({
        provider: "google",
        options: { redirectTo: window.location.origin + BASE },
      });
    },
    async signOut() {
      await sb.auth.signOut();
      window.location.reload();
    },
    onChange(cb) {
      const { data } = sb.auth.onAuthStateChange((_event, session) => {
        cb(session ? toSessionInfo(session.user) : null);
      });
      return () => data.subscription.unsubscribe();
    },
  };
}

/** OAuth リダイレクト後に残る ?code=&state= を URL から掃除する */
export function cleanupOAuthParams(): void {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("code")) return;
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  history.replaceState(null, "", url.pathname + url.search + url.hash);
}
