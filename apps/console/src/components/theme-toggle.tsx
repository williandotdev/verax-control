import { Monitor, Moon, Sun } from 'lucide-react';
import { cn } from '@/lib/cn';
import { type ThemePreference, useTheme } from '@/lib/theme';

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: 'Claro', icon: Sun },
  { value: 'dark', label: 'Escuro', icon: Moon },
  { value: 'system', label: 'Sistema', icon: Monitor },
];

/** Escolha de tema: claro, escuro ou o do sistema operacional. */
export function ThemeToggle() {
  const [preference, setPreference] = useTheme();
  return (
    <div role="radiogroup" aria-label="Tema" className="inline-flex rounded-md border p-0.5">
      {OPTIONS.map(({ value, label, icon: Icon }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={preference === value}
          aria-label={label}
          title={label}
          onClick={() => setPreference(value)}
          className={cn(
            'inline-flex size-7 items-center justify-center rounded-sm text-muted-foreground',
            preference === value && 'bg-foreground/10 text-foreground',
          )}
        >
          <Icon aria-hidden className="size-4" />
        </button>
      ))}
    </div>
  );
}
