// Asks for an approval and exits 0 only when approved.
import { Herald } from '@herald-run/sdk';

const herald = new Herald();
const answer = await herald.askAction({
  title: 'Deploy to production?',
  body: 'The checks passed.',
  actions: [
    { id: 'approve', label: 'Approve', values: {} },
    { id: 'reject', label: 'Reject', values: {} },
  ],
  timeout: '10m',
});
console.log(answer.actionId);
process.exit(answer.actionId === 'approve' ? 0 : 1);
