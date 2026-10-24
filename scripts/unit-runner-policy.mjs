// CI runs a single job, so there is no other job to delegate these contracts to:
// the unit runner owns them on every machine, local and hosted alike.
export const unitRunnerChecks = [
  { name: 'Board bundle budget contract', args: ['run', 'test:board-budget'] },
  { name: 'Board production bundle budget', args: ['run', 'board:budget'] },
  { name: 'Versioned documentation', args: ['run', 'test:versioned-docs'] },
  { name: 'brand asset contracts', args: ['run', 'test:assets'] },
  { name: 'shared UI token contracts', args: ['run', 'test:ui'] },
];
