import { createClient, SupabaseClient } from '@supabase/supabase-js';

// Read from import.meta.env or localStorage (for user dynamic configuration)
const getEnvVar = (key: string): string => {
  if (typeof window !== 'undefined') {
    const local = localStorage.getItem(key);
    if (local) return local;
  }
  return (import.meta as any).env?.[key] || '';
};

let cachedClient: SupabaseClient | null = null;

export const getSupabaseConfig = () => {
  const url = getEnvVar('VITE_SUPABASE_URL');
  const anonKey = getEnvVar('VITE_SUPABASE_ANON_KEY');
  return {
    url,
    anonKey,
    isConfigured: Boolean(url && anonKey && url.startsWith('https://')),
  };
};

export const getSupabaseClient = (): SupabaseClient | null => {
  const { url, anonKey, isConfigured } = getSupabaseConfig();
  if (!isConfigured) return null;

  if (!cachedClient) {
    try {
      cachedClient = createClient(url, anonKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
      });
    } catch (err) {
      console.warn('Failed to initialize Supabase client:', err);
      return null;
    }
  }
  return cachedClient;
};

export const saveSupabaseConfig = (url: string, anonKey: string) => {
  if (typeof window !== 'undefined') {
    localStorage.setItem('VITE_SUPABASE_URL', url.trim());
    localStorage.setItem('VITE_SUPABASE_ANON_KEY', anonKey.trim());
    cachedClient = null; // force re-creation
  }
};

export const clearSupabaseConfig = () => {
  if (typeof window !== 'undefined') {
    localStorage.removeItem('VITE_SUPABASE_URL');
    localStorage.removeItem('VITE_SUPABASE_ANON_KEY');
    cachedClient = null;
  }
};
