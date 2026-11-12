import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // tasks/ holds the starter code, reference solutions and hidden tests of evaluated projects; they follow their own projects' conventions
    ignores: [
      '**/node_modules/',
      '**/dist/',
      'data/',
      '.work/',
      '**/.work/',
      '.spikes/',
      '.interview/',
      'tasks/',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.{js,mjs}'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['server/**/*.ts', 'desktop/**/*.ts'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['web/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
  },
  {
    // shadcn/ui components also export variants functions for reuse by other components
    files: ['web/src/components/ui/**/*.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  prettier,
);
