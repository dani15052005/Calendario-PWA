# Calendario v2

Reescritura limpia de [`Calendario-PWA-main`](../Calendario-PWA-main) en
**Vite + React + TypeScript + Tailwind v4 + Supabase**, desplegada en
Vercel. La app antigua (vanilla JS, monolito 9.300 líneas) sigue
funcionando en GitHub Pages como fallback hasta que esta v2 alcance
paridad de features.

## Stack

- **Vite 8** + React 19 + TypeScript
- **Tailwind CSS v4** (zero-config, plugin de Vite)
- **Supabase JS v2** — auth (magic link) + RLS owner-only
- **TanStack Query** — cache y revalidación de datos
- **date-fns** — manipulación de fechas en español
- **lucide-react** — iconos SVG
- **vite-plugin-pwa** — manifest + service worker auto-generado
- **Vercel** — deploy con previews por PR

## Variables de entorno

Copia `.env.example` a `.env.local`:

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=eyJhbGc...
```

En Vercel, las mismas variables van en
**Project Settings → Environment Variables** (production + preview).

## Comandos

```bash
npm install      # instala deps
npm run dev      # arranca dev server (http://localhost:5173)
npm run build    # build de producción a dist/
npm run preview  # sirve dist/ en local para verificar
npm run lint     # eslint
```

## Estructura

```
src/
├── App.tsx                # Root: QueryClientProvider + AuthGate + Calendar
├── main.tsx               # createRoot + StrictMode
├── index.css              # Tailwind v4 import + tokens (@theme)
├── components/
│   ├── AuthGate.tsx       # Magic link login + owner email check
│   ├── Topbar.tsx         # Sticky header con month-pager
│   ├── MonthView.tsx      # Grid mensual con eventos
│   └── ui/
│       ├── Button.tsx     # Botón con variants (primary/ghost/outline/danger)
│       └── Input.tsx      # Input con focus ring premium
├── hooks/
│   └── useMonthEvents.ts  # React Query hook → events del mes
└── lib/
    ├── supabase.ts        # Cliente Supabase + OWNER_EMAIL + isOwnerEmail
    ├── types.ts           # CalendarEvent, AttachmentMeta, etc.
    ├── dates.ts           # buildMonthGrid, formatMonthYear, etc.
    └── utils.ts           # cn() helper para Tailwind
```

## Roadmap

- [x] **Fase 1 — MVP read-only**: scaffold, auth magic link, vista mes con eventos desde Supabase, deploy Vercel
- [ ] **Fase 2 — CRUD de eventos**: sheet de edición lateral, crear/editar/borrar eventos
- [ ] **Fase 3 — Sync con Google Calendar**: import/push, Edge Function `save-google-token` para refresh token
- [ ] **Fase 4 — Adjuntos en Supabase Storage**: upload, preview, eliminar
- [ ] **Fase 5 — Vistas Día/Semana/Agenda + recordatorios + paridad final**

## Deploy a Vercel

1. https://vercel.com/new → Import Git Repository → seleccionar `calendario-v2`
2. Framework preset: **Vite** (autodetectado)
3. Build command: `npm run build` (autodetectado)
4. Output directory: `dist` (autodetectado)
5. **Environment Variables**: añadir `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY` con los valores de `.env.example`
6. Deploy

Después del primer deploy, en Supabase
(https://supabase.com/dashboard/project/cgrzvvlksfpowymuitne/auth/url-configuration):

- **Site URL**: `https://<tu-app>.vercel.app/`
- **Redirect URLs**: `https://<tu-app>.vercel.app/**` (mantén también el de GitHub Pages mientras la v1 conviva)
