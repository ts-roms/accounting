import type { Config } from 'jest';

const moduleNameMapper = {
  '^@/(.*)$': '<rootDir>/src/$1',
  // Workspace package sources import each other with .js extensions (ESM build); resolve them to .ts here.
  '^(\\.{1,2}/.*)\\.js$': '$1',
  '^@accounting/types$': '<rootDir>/../../packages/types/src/index.ts',
  '^@accounting/validation$': '<rootDir>/../../packages/validation/src/index.ts',
  '^@accounting/config$': '<rootDir>/../../packages/config/src/index.ts',
  '^@accounting/money$': '<rootDir>/../../packages/money/src/index.ts',
};

const config: Config = {
  rootDir: '.',
  // Unit tests live next to the code; e2e suites (test/*.e2e-spec.ts) have their own config.
  roots: ['<rootDir>/src'],
  testEnvironment: 'node',
  moduleFileExtensions: ['js', 'json', 'ts'],
  testRegex: '.*\.spec\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.spec.json' }] },
  moduleNameMapper,
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/main.ts',
    '!src/database/migrations/**',
    '!src/database/seed/**',
  ],
  coverageDirectory: 'coverage',
};

export default config;
