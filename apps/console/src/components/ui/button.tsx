import type { VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/cn';
import { buttonVariants } from './button-variants';

export interface ButtonProps extends ComponentProps<'button'>, VariantProps<typeof buttonVariants> {}

/** Botão do design system do painel (sem o `asChild`: os links usam `buttonVariants` direto). */
export function Button({ className, variant, size, type, ...props }: ButtonProps) {
  return (
    <button className={cn(buttonVariants({ variant, size }), className)} type={type ?? 'button'} {...props} />
  );
}
