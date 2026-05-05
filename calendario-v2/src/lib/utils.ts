import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Combina classNames de Tailwind sin colisiones (estilo shadcn).
 *   cn('px-4', condition && 'px-6') → 'px-6'
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
