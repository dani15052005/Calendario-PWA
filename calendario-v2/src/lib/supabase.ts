import { createClient } from '@supabase/supabase-js'

// Las credenciales se inyectan desde Vercel env vars en producción.
// En local: copiar .env.example a .env.local con tus valores reales.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  // No tiramos en build: queremos que el bundle compile sin env vars (Vercel
  // las inyecta en runtime). Solo emitimos warning en consola al arrancar.
  // eslint-disable-next-line no-console
  console.warn(
    '[supabase] Faltan VITE_SUPABASE_URL o VITE_SUPABASE_ANON_KEY. ' +
    'Configúralas en .env.local (dev) y en Vercel project settings (prod).'
  )
}

export const supabase = createClient(SUPABASE_URL ?? '', SUPABASE_ANON_KEY ?? '', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
})

// El email único autorizado a entrar a la app. Hardcoded por diseño:
// la app es privada owner-only.
export const OWNER_EMAIL = 'andres5871@gmail.com'

export function isOwnerEmail(email: string | null | undefined): boolean {
  return String(email ?? '').trim().toLowerCase() === OWNER_EMAIL
}
