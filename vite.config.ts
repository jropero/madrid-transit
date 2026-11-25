import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';

// The validated `stop` of a /m/rt.php?f=crtm request (same pattern as rt.php), else ''.
const crtmStop = (path: string) => {
  const stop = new URL(path, 'http://x').searchParams.get('stop') ?? '';
  return /^(4|6|8|10)_\d{1,6}$/.test(stop) ? stop : '';
};

// The validated `stop` of a /m/rt.php?f=emt request (same pattern as rt.php), else ''.
const emtStop = (path: string) => {
  const stop = new URL(path, 'http://x').searchParams.get('stop') ?? '';
  return /^\d{1,6}$/.test(stop) ? stop : '';
};

export default defineConfig({
  // Absolute base: relative paths break PWA manifest scope/icon resolution under /m/.
  base: '/m/',
  plugins: [react()],
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
          `/widgets/api/GetStopsTimes.php?codStop=${crtmStop(path)}&type=1&orderBy=2&stopTimesByIti=3`,
      },
      // Dev stand-in for public/rt.php: same URL as production, straight to Renfe's GTFS-RT JSON.
      '/m/rt.php': {
        target: 'https://gtfsrt.renfe.com',
        changeOrigin: true,
        rewrite: path => {
          const f = new URL(path, 'http://x').searchParams.get('f');
          return f === 'trip_updates' || f === 'alerts' ? `/${f}.json` : '/404';
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
