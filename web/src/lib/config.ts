/**
 * The two values the browser is allowed to know: where Supabase is, and the public anon
 * key. Both are visible to any visitor by design; RLS and the Edge Function's own
 * verification are what protect the data. Nothing else is read from the environment here —
 * there is no VITE_ name for a service role key or an Anthropic key, so there is no way for
 * one to be bundled by accident.
 */
export interface WebConfig {
  readonly supabaseUrl: string;
  readonly anonKey: string;
  readonly chatUrl: string;
  /** Stage 3 part 3: the memory page's write endpoint. Reads go straight to PostgREST. */
  readonly memoryUrl: string;
}

export function resolveWebConfig(env: Readonly<Record<string, unknown>>): WebConfig {
  const url = env['VITE_SUPABASE_URL'];
  const key = env['VITE_SUPABASE_ANON_KEY'];
  const supabaseUrl = (typeof url === 'string' ? url : '').trim().replace(/\/+$/, '');
  const anonKey = (typeof key === 'string' ? key : '').trim();
  if (supabaseUrl === '' || anonKey === '') {
    throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set at build time.');
  }
  return {
    supabaseUrl,
    anonKey,
    chatUrl: `${supabaseUrl}/functions/v1/chat`,
    memoryUrl: `${supabaseUrl}/functions/v1/memory`,
  };
}
