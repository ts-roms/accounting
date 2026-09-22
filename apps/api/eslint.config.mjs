import nest from '@accounting/eslint-config/nestjs';

export default [
  ...nest,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/common/time/clock.ts', 'src/database/seed/**', 'src/**/*.spec.ts'],
    rules: {
      // Business "today" (new Date().toISOString().slice(0, 10)) must come from businessToday()
      // so test / demo stacks can pin it; full timestamps stay on the wall clock.
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString'][callee.object.callee.object.type='NewExpression'][callee.object.callee.object.callee.name='Date'][callee.object.callee.object.arguments.length=0][arguments.0.value=0][arguments.1.value=10]",
          message: 'Use businessToday() from @/common/time/clock for calendar dates.',
        },
      ],
    },
  },
];
