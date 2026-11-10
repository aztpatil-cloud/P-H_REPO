/** Verifies a login token by asking Supabase Auth who it belongs to. Works whatever signing scheme the project uses. */
export function createSupabaseVerifier(supabaseUrl: string, anonKey: string, f: typeof fetch = fetch) {
  return async (token: string): Promise<{ id: string; email: string } | null> => {
    try {
      const res = await f(`${supabaseUrl.replace(/\/+$/, '')}/auth/v1/user`, { headers: { apikey: anonKey, authorization: `Bearer ${token}` } });
      if (!res.ok) return null; const u = await res.json() as { id?: string; email?: string };
      return u.id && u.email ? { id: u.id, email: u.email } : null;
    } catch { return null; }
  };
}
