// Sanity gate for a built dist/: exits non-zero when the site is not worth deploying.
// Usage: node scripts/check-dist.mjs [distDir]
import { existsSync, readFileSync, readdirSync } from 'node:fs';

const DIST = process.argv[2] ?? 'dist';
const MIN_STOP_FILES = 1000;
const MIN_DAYS_LEFT = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

const ymdToMs = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
console.assert(ymdToMs('19700102') === DAY_MS, 'ymdToMs');

const missingFiles = () =>
  ['data/stops.json', 'data/days.json', 'rt.php']
    .filter(f => !existsSync(`${DIST}/${f}`))
    .map(f => `missing ${DIST}/${f}`);

function renfeHorizon() {
  const { to } = JSON.parse(readFileSync(`${DIST}/data/days.json`, 'utf8'));
  const left = (ymdToMs(String(to)) - Date.now()) / DAY_MS;
  return left >= MIN_DAYS_LEFT
    ? []
    : [`Renfe timetable ends ${to}, under ${MIN_DAYS_LEFT} days left`];
}

function stopFiles() {
  const n = readdirSync(`${DIST}/data/stop`).length;
  return n > MIN_STOP_FILES ? [] : [`only ${n} stop files (need more than ${MIN_STOP_FILES})`];
}

function main() {
  const missing = missingFiles();
  // The remaining checks read files that must exist.
  const problems = missing.length ? missing : [...renfeHorizon(), ...stopFiles()];
  for (const p of problems) console.error(`check-dist: ${p}`);
  if (problems.length) process.exit(1);
  console.log('check-dist: ok');
}

main();
