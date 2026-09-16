/** Border radius hierarchy (px). Enterprise-moderate: no "bubble UI". */
export const radius = {
  control: 6, // rounded-sm  - buttons, inputs, badges
  input: 6, // rounded-sm
  card: 10, // rounded-lg
  dialog: 12, // rounded-xl
  container: 12, // rounded-xl (up to 16 via rounded-2xl)
} as const;
