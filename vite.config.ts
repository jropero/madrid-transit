import { defineConfig } from 'vite-plus';
import react from '@vitejs/plugin-react';

export default defineConfig({
  // Absolute base: relative paths break PWA manifest scope/icon resolution under /m/.
  base: '/m/',
  plugins: [react()],
  server: {
    proxy: {
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
