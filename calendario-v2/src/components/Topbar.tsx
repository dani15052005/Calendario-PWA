import { ChevronLeft, ChevronRight, LogOut } from 'lucide-react'
import type { Session } from '@supabase/supabase-js'
import { Button } from '@/components/ui/Button'
import { formatMonthYear } from '@/lib/dates'
import { supabase } from '@/lib/supabase'
import { cn } from '@/lib/utils'

interface TopbarProps {
  session: Session
  monthAnchor: Date
  onPrevMonth: () => void
  onNextMonth: () => void
  onToday: () => void
}

export function Topbar({ monthAnchor, onPrevMonth, onNextMonth, onToday }: TopbarProps) {
  return (
    <header
      className={cn(
        'sticky top-0 z-40 flex items-center gap-2 px-3 sm:px-4',
        'min-h-[56px] py-2',
        'bg-white/78 border-b border-border-soft',
        'backdrop-blur-[18px] backdrop-saturate-[180%]',
        'shadow-[0_1px_0_rgb(15_23_42_/_0.02)]'
      )}
    >
      <h1 className="text-base font-bold tracking-tight text-text mr-auto">
        Calendario
      </h1>

      <Button
        variant="outline"
        size="sm"
        onClick={onToday}
        className={cn(
          'rounded-full border-primary-100 text-primary-700 hover:bg-primary-50',
          'font-semibold'
        )}
      >
        Hoy
      </Button>

      <div
        role="group"
        aria-label="Navegación mensual"
        className="inline-flex items-center gap-0.5 bg-surface-soft border border-border-soft rounded-full p-[3px] pl-1 pr-1 shadow-[var(--shadow-xs)]"
      >
        <button
          type="button"
          onClick={onPrevMonth}
          aria-label="Mes anterior"
          className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-full text-text-2 hover:bg-white hover:text-primary-700 transition-colors"
        >
          <ChevronLeft size={16} strokeWidth={2.2} />
        </button>
        <h2
          className="px-2 text-[0.95rem] font-bold tracking-tight text-text capitalize whitespace-nowrap"
          aria-live="polite"
        >
          {formatMonthYear(monthAnchor)}
        </h2>
        <button
          type="button"
          onClick={onNextMonth}
          aria-label="Mes siguiente"
          className="w-[30px] h-[30px] inline-flex items-center justify-center rounded-full text-text-2 hover:bg-white hover:text-primary-700 transition-colors"
        >
          <ChevronRight size={16} strokeWidth={2.2} />
        </button>
      </div>

      <Button
        variant="ghost"
        size="icon"
        onClick={() => supabase.auth.signOut()}
        aria-label="Cerrar sesión"
        title="Cerrar sesión"
        className="ml-1"
      >
        <LogOut size={18} strokeWidth={2} />
      </Button>
    </header>
  )
}
