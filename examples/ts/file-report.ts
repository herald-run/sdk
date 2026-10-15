// Sends a file as a report: reserve, upload, then attach it to a message.
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Herald } from '@herald-run/sdk';

const path = process.argv[2];
if (!path) throw new Error('Usage: node file-report.ts <file>');
const herald = new Herald();
const file = await herald.upload(basename(path), await readFile(path), 'application/pdf');
const message = await herald.send({
  title: 'Nightly report',
  body: 'The report is attached.',
  attachments: [file],
});
console.log(message.id);
