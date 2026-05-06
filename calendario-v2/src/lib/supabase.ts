import { createClient } from '@supabase/supabase-js'

// Fallback hardcoded (anon key es público por diseño; RLS owner-email-only
// protege los datos). Las env vars actúan como override si están bien
// formateadas. Si están mal o faltan, usamos el fallback.
const FALLBACK_SUPABASE_URL = 'https://cgrzvvlksfpowymuitne.supabase.co'
const FALLBACK_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNncnp2dmxrc2Zwb3d5bXVpdG5lIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc5Mjk3MzAsImV4cCI6MjA5MzUwNTczMH0.f8mcmjnc2BUqKh_fcAHqG5trBj19Tzcx85zi-YIY618'

function pickValidUrl(envValue: string): string {
  const trimmed = envValue.trim()
  if (/^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(trimmed)) return trimmed
  return FALLBACK_SUPABASE_URL
}

function pickValidJwt(envValue: string): string {
  const trimmed = envValue.trim()
  const looksJwt = trimmed.startsWith('eyJ') && trimmed.split('.').length === 3
  if (looksJwt) return trimmed
  return FALLBACK_SUPABASE_ANON_KEY
}

const ENV_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').toString()
const ENV_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').toString()

const SUPABASE_URL = pickValidUrl(ENV_URL)
const SUPABASE_ANON_KEY = pickValidJwt(ENV_KEY)

// Diagnóstico al arrancar — visible en F12 → Console.
const _envUrlValid = /^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(ENV_URL.trim())
const _envKeyValid = ENV_KEY.trim().startsWith('eyJ') && ENV_KEY.trim().split('.').length === 3
const _usingEnvUrl = _envUrlValid && SUPABASE_URL === ENV_URL.trim()
const _usingEnvKey = _envKeyValid && SUPABASE_ANON_KEY === ENV_KEY.trim()

/* eslint-disable no-console */
console.log('[supabase] url     =', SUPABASE_URL, _usingEnvUrl ? '(env var)' : '(fallback hardcoded)')
console.log('[supabase] keyLen  =', SUPABASE_ANON_KEY.length, _usingEnvKey ? '(env var)' : '(fallback hardcoded)')
console.log('[supabase] keyHead =', SUPABASE_ANON_KEY.slice(0, 16))
console.log('[supabase] keyTail =', SUPABASE_ANON_KEY.slice(-12))
if (!_usingEnvUrl || !_usingEnvKey) {
  console.warn(
    '[supabase] Usando fallback hardcoded en al menos una credencial — env vars de Vercel ' +
      'están vacías o mal formadas. La app funciona igual; cuando puedas, arregla las env vars ' +
      'y haz redeploy SIN cache.'
  )
}
/* eslint-enable no-console */

export const supabase = createClient(
  SUPABASE_URL || 'https://invalid.invalid',
  SUPABASE_ANON_KEY || 'invalid',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      // Implicit (default): admin generate_link y signInWithOtp ambos
      // devuelven tokens directos en el hash. PKCE causaba que se ignoraran
      // los tokens de admin links (incompatible con su flow).
      flowType: 'implicit',
    },
  }
)

// El email único autorizado a entrar a la app. Hardcoded por diseño:
// la app es privada owner-only.
export const OWNER_EMAIL = 'andres5871@gmail.com'

export function isOwnerEmail(email: string | null | undefined): boolean {
  return String(email ?? '').trim().toLowerCase() === OWNER_EMAIL
}
