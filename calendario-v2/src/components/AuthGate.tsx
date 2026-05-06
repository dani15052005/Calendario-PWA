import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { supabase, OWNER_EMAIL, isOwnerEmail } from '@/lib/supabase'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'

type GateState =
  | { kind: 'loading' }
  | { kind: 'unauthenticated' }
  | { kind: 'sending' }
  | { kind: 'sent'; email: string }
  | { kind: 'error'; message: string }
  | { kind: 'authenticated'; session: Session }
  | { kind: 'wrong-owner'; email: string }

interface AuthGateProps {
  children: (session: Session) => ReactNode
}

export function AuthGate({ children }: AuthGateProps) {
  const [state, setState] = useState<GateState>({ kind: 'loading' })
  const [emailInput, setEmailInput] = useState<string>(() => {
    try { return localStorage.getItem('auth.lastEmail') ?? '' } catch { return '' }
  })

  // Carga inicial de sesión + suscripción a cambios.
  useEffect(() => {
    let cancelled = false

    async function init() {
      const { data, error } = await supabase.auth.getSession()
      if (cancelled) return
      if (error) {
        setState({ kind: 'error', message: `Error de sesión: ${error.message}` })
        return
      }
      applySession(data.session)
    }

    function applySession(session: Session | null) {
      if (!session?.user) {
        setState({ kind: 'unauthenticated' })
        return
      }
      const userEmail = session.user.email ?? ''
      if (!isOwnerEmail(userEmail)) {
        // Owner gate cliente — la RLS de Supabase ya bloquea de todos modos.
        supabase.auth.signOut().catch(() => {})
        setState({ kind: 'wrong-owner', email: userEmail })
        return
      }
      setState({ kind: 'authenticated', session })
    }

    init()

    const { data: sub } = supabase.auth.onAuthStateChange(
      (_event: AuthChangeEvent, session: Session | null) => {
        if (cancelled) return
        applySession(session)
      }
    )

    return () => {
      cancelled = true
      sub.subscription.unsubscribe()
    }
  }, [])

  async function sendMagicLink(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const email = emailInput.trim().toLowerCase()
    if (!email) return
    if (!isOwnerEmail(email)) {
      setState({
        kind: 'error',
        message: `Solo ${OWNER_EMAIL} puede acceder a este calendario.`,
      })
      return
    }
    setState({ kind: 'sending' })
    try { localStorage.setItem('auth.lastEmail', email) } catch { /* ignore */ }

    try {
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: {
          emailRedirectTo: window.location.origin + window.location.pathname,
          shouldCreateUser: true,
        },
      })
      if (error) {
        // eslint-disable-next-line no-console
        console.error('[AuthGate] signInWithOtp returned error:', error)
        setState({ kind: 'error', message: `No se pudo enviar el enlace: ${error.message}` })
        return
      }
    } catch (err) {
      // Errores de red / fetch inválido / config rota → caen aquí.
      // eslint-disable-next-line no-console
      console.error('[AuthGate] signInWithOtp threw:', err)
      const detail = err instanceof Error ? err.message : String(err)
      setState({
        kind: 'error',
        message:
          `Error de red al enviar enlace: ${detail}. Abre la consola (F12) ` +
          `y mira los logs [supabase] al inicio para confirmar que las env vars están bien.`,
      })
      return
    }
    setState({ kind: 'sent', email })
  }

  if (state.kind === 'authenticated') {
    return <>{children(state.session)}</>
  }

  return <AuthShell>
    <div className="text-center">
      <h2 className="text-[1.35rem] font-bold tracking-tight text-text mb-1.5">Acceso privado</h2>
      <Message state={state} />
      <p className="text-xs text-muted bg-surface-soft px-3 py-2 rounded-[var(--radius-sm)] my-4 inline-block">
        Propietario permitido: <strong className="text-text-2">{OWNER_EMAIL}</strong>
      </p>
    </div>

    {(state.kind === 'unauthenticated' ||
      state.kind === 'error' ||
      state.kind === 'wrong-owner') && (
      <form onSubmit={sendMagicLink} className="flex flex-col gap-2.5 mt-1">
        <Input
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder={OWNER_EMAIL}
          value={emailInput}
          onChange={(e) => setEmailInput(e.target.value)}
          required
        />
        <Button type="submit" variant="primary" size="lg" className="w-full">
          Enviar enlace de acceso
        </Button>
      </form>
    )}

    {state.kind === 'sending' && (
      <div className="flex flex-col gap-2.5 mt-1">
        <Button type="button" variant="primary" size="lg" disabled className="w-full">
          Enviando enlace…
        </Button>
      </div>
    )}
  </AuthShell>
}

function Message({ state }: { state: GateState }) {
  switch (state.kind) {
    case 'loading':
      return <p className="text-sm text-muted m-0">Comprobando sesión…</p>
    case 'unauthenticated':
      return <p className="text-sm text-muted m-0">Introduce tu email para recibir un enlace de acceso.</p>
    case 'sending':
      return <p className="text-sm text-muted m-0">Enviando enlace…</p>
    case 'sent':
      return (
        <p className="text-sm text-success m-0">
          Enlace enviado a <strong>{state.email}</strong>. Revisa tu bandeja
          (también spam). Abre el enlace desde este mismo navegador para
          completar el acceso.
        </p>
      )
    case 'error':
      return <p className="text-sm text-danger m-0">{state.message}</p>
    case 'wrong-owner':
      return (
        <p className="text-sm text-danger m-0">
          Acceso bloqueado para <strong>{state.email}</strong>. Solo el propietario tiene acceso.
        </p>
      )
    case 'authenticated':
      return null
  }
}

function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-5 pb-[calc(20px+var(--sat-bottom))] bg-bg">
      <div
        aria-hidden
        className="absolute inset-0 -z-10 bg-[radial-gradient(ellipse_80%_60%_at_50%_0%,rgb(14_165_233/0.10),transparent_70%)]"
      />
      <div className="w-full max-w-[380px] bg-white border border-border-soft rounded-[var(--radius-xl)] p-7 shadow-[var(--shadow-xl)] animate-[fadeIn_280ms_cubic-bezier(.2,.8,.2,1)_both]">
        {children}
      </div>
    </div>
  )
}
