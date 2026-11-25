import { loadJson, saveJson } from './storage.ts';

// The 20 Windows Phone 8 accent colours; `dark` marks the ones that need black text.
export const ACCENTS = [
  { name: 'lime', hex: '#a4c400', dark: true },
  { name: 'green', hex: '#60a917' },
  { name: 'emerald', hex: '#008a00' },
  { name: 'teal', hex: '#00aba9' },
  { name: 'cyan', hex: '#1ba1e2' },
  { name: 'cobalt', hex: '#0050ef' },
  { name: 'indigo', hex: '#6a00ff' },
  { name: 'violet', hex: '#aa00ff' },
  { name: 'pink', hex: '#f472d0' },
  { name: 'magenta', hex: '#d80073' },
  { name: 'crimson', hex: '#a20025' },
  { name: 'red', hex: '#e51400' },
  { name: 'orange', hex: '#fa6800' },
  { name: 'amber', hex: '#f0a30a', dark: true },
  { name: 'yellow', hex: '#e3c800', dark: true },
  { name: 'brown', hex: '#825a2c' },
  { name: 'olive', hex: '#6d8764' },
  { name: 'steel', hex: '#647687' },
  { name: 'mauve', hex: '#76608a' },
  { name: 'taupe', hex: '#87794e' },
] as const;

export type AccentName = (typeof ACCENTS)[number]['name'];

const KEY = 'madrid-transit:accent';
const DEFAULT: AccentName = 'cobalt';

export const loadAccent = (): AccentName => {
  const n = loadJson<string>(KEY, DEFAULT);
  return ACCENTS.some(a => a.name === n) ? (n as AccentName) : DEFAULT;
};

// Sets the CSS variables on <html>; persist=false for the initial paint.
export function applyAccent(name: AccentName, persist = true) {
  const a = ACCENTS.find(x => x.name === name) ?? ACCENTS[5];
  const root = document.documentElement.style;
  root.setProperty('--accent', a.hex);
  root.setProperty('--on-accent', 'dark' in a ? '#000' : '#fff');
  if (persist) saveJson(KEY, name);
}
