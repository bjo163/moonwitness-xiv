export const localServiceScripts = {
  dev: [
    ['@moonwitness/api', 'dev'],
    ['@moonwitness/api', 'jobs:outbox'],
    ['@moonwitness/api', 'jobs:worker'],
    ['@moonwitness/api', 'jobs:scheduler'],
    ['@moonwitness/board', 'dev'],
  ],
  start: [
    ['@moonwitness/api', 'start'],
    ['@moonwitness/api', 'jobs:outbox'],
    ['@moonwitness/api', 'jobs:worker'],
    ['@moonwitness/api', 'jobs:scheduler'],
    ['@moonwitness/board', 'start'],
  ],
  'start:built': [
    ['@moonwitness/api', 'start:built'],
    ['@moonwitness/api', 'jobs:outbox'],
    ['@moonwitness/api', 'jobs:worker:built'],
    ['@moonwitness/api', 'jobs:scheduler:built'],
    ['@moonwitness/board', 'start:built'],
  ],
};
