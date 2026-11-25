import { loadJson, saveJson } from './storage.ts';

// The 20 Windows Phone 8 accent colours; `dark` marks the ones that need black text.
export const ACCENTS = [
  // `label` is the Spanish name shown to screen readers; `name` stays the stored id.
  { name: 'lime', label: 'lima', hex: '#a4c400', dark: true },
  { name: 'green', label: 'verde', hex: '#60a917' },
  { name: 'emerald', label: 'esmeralda', hex: '#008a00' },
  { name: 'teal', label: 'verde azulado', hex: '#00aba9' },
  { name: 'cyan', label: 'cian', hex: '#1ba1e2' },
  { name: 'cobalt', label: 'cobalto', hex: '#0050ef' },
  { name: 'indigo', label: 'índigo', hex: '#6a00ff' },
  { name: 'violet', label: 'violeta', hex: '#aa00ff' },
  { name: 'pink', label: 'rosa', hex: '#f472d0' },
  { name: 'magenta', label: 'magenta', hex: '#d80073' },
  { name: 'crimson', label: 'carmesí', hex: '#a20025' },
  { name: 'red', label: 'rojo', hex: '#e51400' },
  { name: 'orange', label: 'naranja', hex: '#fa6800' },
  { name: 'amber', label: 'ámbar', hex: '#f0a30a', dark: true },
  { name: 'yellow', label: 'amarillo', hex: '#e3c800', dark: true },
  { name: 'brown', label: 'marrón', hex: '#825a2c' },
  { name: 'olive', label: 'oliva', hex: '#6d8764' },
  { name: 'steel', label: 'acero', hex: '#647687' },
  { name: 'mauve', label: 'malva', hex: '#76608a' },
  { name: 'taupe', label: 'topo', hex: '#87794e' },
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
