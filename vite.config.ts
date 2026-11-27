import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite-plus';
import { avisosBlock } from './scripts/avisos-block.mjs';

const AVISOS_MODES = ['interurbanos', 'metro', 'metro-ligero'];

// Dev stand-in for rt.php's `f=crtm_avisos&m=<mode>`: fetches the CRTM page and answers
// {html, at} like production (mode validated against the same list, errors are 502).
type DevReq = { url?: string };
type DevRes = {
  statusCode: number;
  setHeader(k: string, v: string): void;
  end(b: string): void;
};

async function serveAvisos(req: DevReq, res: DevRes, next: () => void) {
  const q = new URL(req.url ?? '', 'http://x').searchParams;
  if (q.get('f') !== 'crtm_avisos') return next();
  const mode = q.get('m') ?? '';
  const send = (code: number, type: string, body: string) => {
    res.statusCode = code;
    res.setHeader('Content-Type', type);
    res.end(body);
  };
  if (!AVISOS_MODES.includes(mode)) return send(400, 'text/plain', 'bad mode');
  try {
    const url = `https://www.crtm.es/comunicacion/actualidad-del-servicio/avisos/avisos-${mode}/`;
    const r = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    const html = r.ok ? avisosBlock(await r.text()) : null;
    if (html === null) return send(502, 'text/plain', 'upstream unavailable');
    send(200, 'application/json', JSON.stringify({ html, at: Math.floor(Date.now() / 1000) }));
  } catch {
    send(502, 'text/plain', 'upstream unavailable');
  }
}

const avisosDev = (): Plugin => ({
  name: 'crtm-avisos-dev',
  configureServer(server) {
    // The cast: the Connect handler types come from node typings this project does not load.
    const handler = (req: DevReq, res: DevRes, next: () => void) =>
      void serveAvisos(req, res, next);
    server.middlewares.use('/m/rt.php', handler as never);
  },
});

// The validated `stop` of a /m/rt.php?f=crtm request (same pattern as rt.php), else ''.
const crtmStop = (path: string) => {
  const stop = new URL(path, 'http://x').searchParams.get('stop') ?? '';
  return /^(4|6|8|10)_\d{1,6}$/.test(stop) ? stop : '';
};

// 2 when a /m/rt.php?f=crtm request asks for arrivals (`type=2`), else 1.
const crtmType = (path: string) =>
  new URL(path, 'http://x').searchParams.get('type') === '2' ? 2 : 1;

// The validated `stop` of a /m/rt.php?f=emt request (same pattern as rt.php), else ''.
const emtStop = (path: string) => {
  const stop = new URL(path, 'http://x').searchParams.get('stop') ?? '';
  return /^\d{1,6}$/.test(stop) ? stop : '';
};

export default defineConfig({
  // Absolute base: relative paths break PWA manifest scope/icon resolution under /m/.
  base: '/m/',
  plugins: [react(), avisosDev()],
  server: {
    proxy: {
      // EMT needs credentials that only exist on the server: dev forwards to the deployed rt.php.
      '^/m/rt\\.php\\?f=emt(&|$)': {
        target: 'https://ekult.co.uk',
        changeOrigin: true,
        bypass: req => (emtStop(req.url ?? '') ? undefined : false),
        rewrite: path => `/m/rt.php?f=emt&stop=${emtStop(path)}`,
      },
      // Dev stand-in for public/rt.php (crtm feed): same URL as production, straight to CRTM.
      // Listed first so it wins; an invalid stop never leaves the dev server (bypass answers 404).
      '^/m/rt\\.php\\?f=crtm(&|$)': {
        target: 'https://www.crtm.es',
        changeOrigin: true,
        bypass: req => (crtmStop(req.url ?? '') ? undefined : false),
        rewrite: path =>
          `/widgets/api/GetStopsTimes.php?codStop=${crtmStop(path)}&type=${crtmType(path)}&orderBy=2&stopTimesByIti=3`,
      },
      // Dev stand-in for public/rt.php: same URL as production, straight to Renfe's GTFS-RT JSON.
      '/m/rt.php': {
        target: 'https://gtfsrt.renfe.com',
        changeOrigin: true,
        rewrite: path => {
          const f = new URL(path, 'http://x').searchParams.get('f');
          const feeds: (string | null)[] = [
            'trip_updates',
            'trip_updates_LD',
            'alerts',
            'vehicle_positions',
            'vehicle_positions_LD',
          ];
          return feeds.includes(f) ? `/${f}.json` : '/404';
        },
      },
    },
  },
  staged: {
    '*.{ts,tsx,js,mjs,mts}': ['vp lint --fix', 'vp fmt'],
    '*.{json,md,html}': 'vp fmt --no-error-on-unmatched-pattern',
    '*.css': 'stylelint --fix',
  },
  fmt: {
    ignorePatterns: ['.claude/**', 'public/**'],
    singleQuote: true,
    trailingComma: 'all',
    printWidth: 96,
    tabWidth: 2,
    semi: true,
    arrowParens: 'avoid',
    bracketSpacing: true,
    bracketSameLine: false,
    endOfLine: 'lf',
  },
  lint: {
    plugins: ['react', 'jsx-a11y', 'typescript'],
    jsPlugins: [
      { name: 'vite-plus', specifier: 'vite-plus/oxlint-plugin' },
      { name: 'sonarjs', specifier: './lint/sonarjs.js' },
    ],
    ignorePatterns: ['.claude/**', 'dist/**', 'public/**'],
    env: { browser: true, es2022: true },
    options: { typeAware: true, typeCheck: true },
    rules: {
      'vite-plus/prefer-vite-plus-imports': 'error',
      // React 17+ JSX transform: no need to import React in every file
      'react/react-in-jsx-scope': 'off',
      // Glyph-only marks (⚠, ♿) are text spans labelled with role="img"; <img> cannot hold text
      'jsx-a11y/prefer-tag-over-role': 'off',
      // Fetch-on-mount/refresh effects call async loaders that set state; that is the pattern here
      'react/set-state-in-effect': 'off',
      'react-hooks/exhaustive-deps': 'error',
      // SonarJS quality gates (via JS plugin)
      'sonarjs/cognitive-complexity': ['error', 6],
      'sonarjs/no-nested-conditional': 'error',
      'sonarjs/no-duplicate-string': ['error', { threshold: 10 }],
      'sonarjs/no-identical-functions': 'error',
      'sonarjs/no-collapsible-if': 'error',
      'sonarjs/todo-tag': 'error',
      'sonarjs/no-globals-shadowing': 'error',
      'sonarjs/concise-regex': 'error',
      'sonarjs/slow-regex': 'error',
      'sonarjs/code-eval': 'error',
      'sonarjs/pseudo-random': 'off',
    },
  },
});
