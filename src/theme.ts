import { loadJson, saveJson } from './storage.ts';

export const THEMES = [
  { name: 'auto', label: 'automático' },
  { name: 'light', label: 'claro' },
  { name: 'dark', label: 'oscuro' },
] as const;

export type Theme = (typeof THEMES)[number]['name'];

const KEY = 'madrid-transit:theme';
const COLOURS = { light: '#ffffff', dark: '#000000' };

export const loadTheme = (): Theme => {
  const t = loadJson<string>(KEY, 'auto');
  return THEMES.some(x => x.name === t) ? (t as Theme) : 'auto';
};

// Forced themes get one theme-color meta; automatic restores the media-query pair.
function syncThemeColor(theme: Theme) {
  document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.remove());
  const add = (content: string, media?: string) => {
    const m = document.createElement('meta');
    m.name = 'theme-color';
    m.content = content;
    if (media) m.media = media;
    document.head.append(m);
  };
  if (theme === 'auto') {
    add(COLOURS.light, '(prefers-color-scheme: light)');
    add(COLOURS.dark, '(prefers-color-scheme: dark)');
  } else add(COLOURS[theme]);
}

// data-theme absent = automatic; persist=false for the initial paint.
export function applyTheme(theme: Theme, persist = true) {
  const root = document.documentElement;
  if (theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = theme;
  syncThemeColor(theme);
  if (persist) saveJson(KEY, theme);
}
