import { forwardRef, type ButtonHTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const buttonStyles = cva(
  'inline-flex items-center justify-center gap-2 rounded-[var(--radius-sm)] font-medium transition-[background,color,box-shadow,transform] duration-150 disabled:opacity-55 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-primary focus-visible:outline-offset-2',
  {
    variants: {
      variant: {
        primary:
          'bg-gradient-to-b from-primary to-primary-600 text-white border border-primary-600 shadow-[var(--shadow-xs)] hover:brightness-105 hover:-translate-y-px active:translate-y-0 active:brightness-95',
        ghost:
          'bg-transparent text-text-2 border border-transparent hover:bg-surface-soft hover:text-text hover:border-border-soft',
        outline:
          'bg-white text-text border border-border hover:bg-surface-soft',
        danger:
          'bg-white text-danger border border-danger/30 hover:bg-danger-50 hover:border-danger/55',
      },
      size: {
        sm: 'h-9 px-3 text-sm',
        md: 'h-11 px-4 text-[0.95rem]',
        lg: 'h-12 px-5 text-base',
        icon: 'h-10 w-10 p-0',
      },
    },
    defaultVariants: {
      variant: 'primary',
      size: 'md',
    },
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonStyles> {}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, type = 'button', ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonStyles({ variant, size }), className)}
      {...rest}
    />
  )
})
