import { useEffect, useState } from 'react';
import { fetchWeather, storedWeather, weatherKey } from './data.ts';
import { Icon } from './icons.tsx';
import { formatTemp, weatherInfo, type WeatherNow } from './weather.ts';

// Current weather at the stop (`key` from `weatherKey`; null without coordinates). The stored
// copy shows at once; the memoised fetch refreshes it, and again when the page becomes visible.
function useWeather(key: string | null) {
  const [w, setW] = useState<{ key: string; now: WeatherNow | null } | null>(null);
  useEffect(() => {
    if (!key) return;
    let current = true;
    const load = () => void fetchWeather(key).then(now => current && setW({ key, now }));
    const onVisible = () => document.visibilityState === 'visible' && load();
    load();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      current = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key]);
  if (!key) return null;
  return w?.key === key ? w.now : storedWeather(key);
}

export function WeatherMark({ lat, lon }: { lat?: number; lon?: number }) {
  const key = lat === undefined || lon === undefined ? null : weatherKey(lat, lon);
  const now = useWeather(key);
  if (!now) return null;
  const info = weatherInfo(now.code, now.day);
  const temp = formatTemp(now.t);
  const label = `${info ? `${info.label}, ` : ''}${temp.replace('°', ' °C')}`;
  return (
    <span className="weather" role="img" aria-label={label} title={label}>
      {info && <Icon name={info.icon} size={36} />}
      {temp}
    </span>
  );
}
