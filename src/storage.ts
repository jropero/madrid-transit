// localStorage helpers (always try/catch) with oldest-first eviction of cache-like entries.
const PREFIX = 'madrid-transit:';
// Keys that hold `{ at, ... }` caches and may be dropped when storage is full.
const DISPOSABLE = [`${PREFIX}cache:`];

export function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

/** Cache-like keys (JSON `{ at }`), oldest first; missing or unparseable `at` counts as 0. */
function disposableKeysOldestFirst(): string[] {
  try {
    const keys: { key: string; at: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !DISPOSABLE.some(p => key.startsWith(p))) continue;
      keys.push({ key, at: Number(loadJson<{ at?: number }>(key, {}).at) || 0 });
    }
    return keys.sort((a, b) => a.at - b.at).map(k => k.key);
  } catch {
    return [];
  }
}

export function saveJson(key: string, value: unknown) {
  const json = JSON.stringify(value);
  try {
    localStorage.setItem(key, json);
    return;
  } catch {
    // Full or unavailable: evict disposable entries below.
  }
  for (const old of disposableKeysOldestFirst()) {
    if (old === key) continue;
    try {
      localStorage.removeItem(old);
      localStorage.setItem(key, json);
      return;
    } catch {
      // Still full (or unavailable): try the next one.
    }
  }
}
