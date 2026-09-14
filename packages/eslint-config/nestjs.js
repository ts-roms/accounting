import globals from 'globals';
import { baseConfig } from './base.js';

export default [
  ...baseConfig,
  {
    languageOptions: { globals: { ...globals.node, ...globals.jest } },
    rules: {
      // Nest relies heavily on decorators + DI; class-based patterns are expected.
      '@typescript-eslint/no-extraneous-class': 'off',
      // Constructor injection relies on emitDecoratorMetadata, which needs VALUE
      // imports for injected classes; type-only imports would break DI.
      '@typescript-eslint/consistent-type-imports': 'off',
    },
  },
];
