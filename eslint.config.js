import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs}'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        Buffer: 'readonly',
        BigInt: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable', process: 'readonly', console: 'readonly' },
    },
  },
  {
    ignores: ['node_modules/', '**/node_modules/', 'control-plane/public/'],
  },
];
