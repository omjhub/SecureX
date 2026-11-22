const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  { ignores: ['public/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    files: ['src/**/*.js'],
    languageOptions: { ecmaVersion: 2022, sourceType: 'module', globals: globals.browser },
  },
  {
    files: ['*.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node },
  },
];
