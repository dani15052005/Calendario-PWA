import { forwardRef, type InputHTMLAttributes } from 'react'
import { cn } from '@/lib/utils'

export type InputProps = InputHTMLAttributes<HTMLInputElement>

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, type = 'text', ...rest },
  ref
) {
  return (
    <input
      ref={ref}
      type={type}
      className={cn(
        'h-12 w-full rounded-[var(--radius-sm)] border border-border bg-white px-4 text-[0.95rem]',
        'placeholder:text-muted-2',
        'focus:border-primary focus:outline-none focus:shadow-[0_0_0_3px_rgb(14_165_233_/_0.30)]',
        'transition-[border-color,box-shadow] duration-150',
        className
      )}
      {...rest}
    />
  )
})
