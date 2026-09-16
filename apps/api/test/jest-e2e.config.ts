import type { Config } from 'jest';

const config: Config = {
  rootDir: '..',
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\.e2e-spec\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }] },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@accounting/types$': '<rootDir>/../../packages/types/src/index.ts',
    '^@accounting/validation$': '<rootDir>/../../packages/validation/src/index.ts',
    '^@accounting/config$': '<rootDir>/../../packages/config/src/index.ts',
    '^@accounting/money$': '<rootDir>/../../packages/money/src/index.ts',
  },
  globalSetup: '<rootDir>/test/global-setup.ts',
  setupFiles: ['<rootDir>/test/setup-env.ts'],
  testTimeout: 60000,
};

export default config;
