import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import hooks from 'eslint-plugin-react-hooks';

const NO_HTML = { selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']", message: 'Never render remote text as HTML.' };

export default tseslint.config(
  { ignores: ['dist'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { 'react-hooks': hooks },
    rules: {
      ...hooks.configs.recommended.rules,
      'no-restricted-syntax': ['error', NO_HTML],
      'no-eval': 'error',
      'no-implied-eval': 'error',
    },
  },
  // Layering (ADR-030): src/ui renders; data, backend calls and app state live in src/logic.
  {
    files: ['src/ui/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [{ name: '@tanstack/react-query', message: 'Queries and mutations belong in a src/logic hook.' }],
          patterns: [
            { group: ['@tauri-apps/*'], message: 'Only src/logic/api.ts talks to the backend.' },
            {
              group: ['**/logic/api'],
              importNames: ['api', 'events'],
              message: 'Call the backend from a src/logic hook, not from a component.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['src/ui/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', { selector: 'Program', message: 'src/ui holds .tsx components only; put logic in src/logic.' }] },
  },
  {
    files: ['src/logic/**'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['**/ui', '**/ui/**'], message: 'src/logic must not depend on components.' }] }],
      'no-restricted-syntax': ['error', NO_HTML, { selector: 'JSXElement, JSXFragment', message: 'No JSX in src/logic; render in src/ui.' }],
    },
  },
  {
    files: ['src/logic/**/*.tsx'],
    rules: { 'no-restricted-syntax': ['error', { selector: 'Program', message: 'src/logic holds .ts modules only; put components in src/ui.' }] },
  },
);
