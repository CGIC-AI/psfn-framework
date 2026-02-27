// ── Theme store — dark/light mode ──

const STORAGE_KEY = 'psfn_theme';

type Theme = 'light' | 'dark';

let theme = $state<Theme>('light');

export function initTheme(): void {
  const stored = localStorage.getItem(STORAGE_KEY) as Theme | null;
  if (stored === 'dark' || stored === 'light') {
    theme = stored;
  } else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    theme = 'dark';
  }
  applyTheme();
}

export function getTheme(): Theme {
  return theme;
}

export function isDark(): boolean {
  return theme === 'dark';
}

export function toggleTheme(): void {
  theme = theme === 'dark' ? 'light' : 'dark';
  localStorage.setItem(STORAGE_KEY, theme);
  applyTheme();
}

function applyTheme(): void {
  if (theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}
