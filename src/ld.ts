import { useSyncExternalStore } from 'react';
import { loadJson, saveJson } from './storage.ts';

// "Trenes de media y larga distancia" setting: on by default, shared by every component.
const KEY = 'madrid-transit:ld';
let enabled = loadJson<unknown>(KEY, true) !== false;
const listeners = new Set<() => void>();

export const ldEnabled = () => enabled;

export function setLdEnabled(on: boolean) {
  enabled = on;
  saveJson(KEY, on);
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export const useLdEnabled = () => useSyncExternalStore(subscribe, ldEnabled);
