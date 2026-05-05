import { useState } from 'react'
import type { Session } from '@supabase/supabase-js'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { AuthGate } from '@/components/AuthGate'
import { Topbar } from '@/components/Topbar'
import { MonthView } from '@/components/MonthView'
import { shiftMonth } from '@/lib/dates'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
})

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        {(session) => <CalendarApp session={session} />}
      </AuthGate>
    </QueryClientProvider>
  )
}

function CalendarApp({ session }: { session: Session }) {
  const [monthAnchor, setMonthAnchor] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })

  return (
    <div className="min-h-dvh flex flex-col">
      <Topbar
        session={session}
        monthAnchor={monthAnchor}
        onPrevMonth={() => setMonthAnchor((d) => shiftMonth(d, -1))}
        onNextMonth={() => setMonthAnchor((d) => shiftMonth(d, 1))}
        onToday={() => {
          const now = new Date()
          setMonthAnchor(new Date(now.getFullYear(), now.getMonth(), 1))
        }}
      />
      <main className="flex-1 max-w-[1480px] w-full mx-auto p-2 sm:p-4 lg:p-6 pb-[calc(20px+var(--sat-bottom))]">
        <MonthView monthAnchor={monthAnchor} />
      </main>
    </div>
  )
}

export default App
