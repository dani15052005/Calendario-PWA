import { createClient } from '@supabase/supabase-js'

// Las credenciales se inyectan desde Vercel env vars en producción.
// En local: copiar .env.example a .env.local con tus valores reales.
const SUPABASE_URL = (import.meta.env.VITE_SUPABASE_URL ?? '').toString().trim()
const SUPABASE_ANON_KEY = (import.meta.env.VITE_SUPABASE_ANON_KEY ?? '').toString().trim()

// Diagnóstico al arrancar — visible en F12 → Console.
// El URL es público; el anon key también es público por diseño (RLS protege).
const _isValidUrl = /^https:\/\/[a-z0-9]+\.supabase\.co$/i.test(SUPABASE_URL)
const _keyLooksJwt =
  SUPABASE_ANON_KEY.startsWith('eyJ') && SUPABASE_ANON_KEY.split('.').length === 3

// Logs sueltos (no Object) para que se vean expandidos en consola.
/* eslint-disable no-console */
console.log('[supabase] urlPresent =', !!SUPABASE_URL)
console.log('[supabase] urlValid   =', _isValidUrl)
console.log('[supabase] url        =', SUPABASE_URL || '(VACÍO)')
console.log('[supabase] keyPresent =', !!SUPABASE_ANON_KEY)
console.log('[supabase] keyLooksJwt=', _keyLooksJwt)
console.log('[supabase] keyLength  =', SUPABASE_ANON_KEY.length)
console.log('[supabase] keyPrefix  =', SUPABASE_ANON_KEY.slice(0, 12) || '(VACÍO)')
console.log('[supabase] keySuffix  =', SUPABASE_ANON_KEY.slice(-12) || '(VACÍO)')
/* eslint-enable no-console */

if (!_isValidUrl || !_keyLooksJwt) {
  // eslint-disable-next-line no-console
  console.error(
    '[supabase] Configuración inválida. ' +
      'En Vercel → Project Settings → Environment Variables verifica que existan ' +
      'VITE_SUPABASE_URL (https://<ref>.supabase.co) y VITE_SUPABASE_ANON_KEY (JWT que empieza por eyJ). ' +
      'Sin espacios ni saltos de línea. Después haz REDEPLOY — Vite inyecta vars en build, no runtime.'
  )
}

export const supabase = createClient(
  SUPABASE_URL || 'https://invalid.invalid',
  SUPABASE_ANON_KEY || 'invalid',
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      flowType: 'pkce',
    },
  }
)

// El email único autorizado a entrar a la app. Hardcoded por diseño:
// la app es privada owner-only.
export const OWNER_EMAIL = 'andres5871@gmail.com'

export function isOwnerEmail(email: string | null | undefined): boolean {
  return String(email ?? '').trim().toLowerCase() === OWNER_EMAIL
}
