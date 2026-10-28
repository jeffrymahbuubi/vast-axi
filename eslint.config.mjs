import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.claude/**', '.claude-flow/**', '.swarm/**', '.venv/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['tests/helpers/*.cjs'],
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
);
