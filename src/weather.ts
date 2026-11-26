// Current weather for the stop title: pure mapping of Open-Meteo / WMO codes to a Fluent icon
// and a Spanish label. Fetching lives in `data.ts`.
import type { IconName } from './icons.tsx';

export type WeatherNow = { t: number; code: number; day: boolean };

// WMO code -> [day icon, night icon, label].
type Entry = [IconName, IconName, string];
const WEATHER: [number[], Entry][] = [
  [[0], ['sunny', 'moon', 'Despejado']],
  [[1], ['sunny', 'moon', 'Mayormente despejado']],
  [[2], ['partlyDay', 'partlyNight', 'Parcialmente nuboso']],
  [[3], ['cloudy', 'cloudy', 'Nublado']],
  [
    [45, 48],
    ['fog', 'fog', 'Niebla'],
  ],
  [
    [51, 53, 55, 56, 57],
    ['drizzle', 'drizzle', 'Llovizna'],
  ],
  [
    [61, 63, 65],
    ['rain', 'rain', 'Lluvia'],
  ],
  [
    [66, 67],
    ['rain', 'rain', 'Lluvia helada'],
  ],
  [
    [71, 73, 75, 77],
    ['snow', 'snow', 'Nieve'],
  ],
  [
    [80, 81, 82],
    ['showers', 'showers', 'Chubascos'],
  ],
  [
    [85, 86],
    ['snowShower', 'snowShower', 'Chubascos de nieve'],
  ],
  [
    [95, 96, 99],
    ['thunder', 'thunder', 'Tormenta'],
  ],
];
const BY_CODE = new Map(WEATHER.flatMap(([codes, e]) => codes.map(c => [c, e] as const)));

export function weatherInfo(
  code: number,
  day: boolean,
): { icon: IconName; label: string } | null {
  const e = BY_CODE.get(code);
  return e ? { icon: day ? e[0] : e[1], label: e[2] } : null;
}

/** "14°", "−3°" (minus sign), never "-0°". */
export function formatTemp(t: number): string {
  const n = Math.round(t);
  return `${n < 0 ? '−' : ''}${Math.abs(n)}°`;
}

/** Open-Meteo `current` block, or null when it lacks a usable temperature. */
export function parseWeather(json: unknown): WeatherNow | null {
  const c = (json as { current?: Record<string, unknown> } | null)?.current;
  const t = c?.temperature_2m;
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  return { t, code: Number(c?.weather_code), day: c?.is_day !== 0 };
}

console.assert(weatherInfo(0, true)?.icon === 'sunny', 'clear day');
console.assert(weatherInfo(0, false)?.icon === 'moon', 'clear night');
console.assert(weatherInfo(2, false)?.icon === 'partlyNight', 'partly cloudy night');
console.assert(weatherInfo(63, true)?.label === 'Lluvia', 'rain');
console.assert(weatherInfo(96, true)?.label === 'Tormenta', 'thunderstorm');
console.assert(weatherInfo(12, true) === null, 'unknown code');
console.assert(formatTemp(14.4) === '14°' && formatTemp(-2.6) === '−3°', 'temp format');
console.assert(formatTemp(-0.2) === '0°', 'no negative zero');
console.assert(
  parseWeather({ current: { temperature_2m: 9.5, weather_code: 3, is_day: 0 } })?.day === false,
  'parse night',
);
console.assert(parseWeather({}) === null, 'parse empty');
