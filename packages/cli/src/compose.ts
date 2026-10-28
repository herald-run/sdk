import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { duration, type Attachment, type Herald, type MessageRequest } from '@herald-run/sdk';
import {
  actionSchema,
  destinationSchema,
  fieldSchema,
  messageInputSchema,
  reviewBlockTypes,
  type DestinationRegistration,
  type Field,
  type RequestAction,
} from '@herald-run/sdk/schema';
import type { z } from 'zod';
import { fileType, uploadPath } from './files';
import { isSecret, type Output } from './secrets';

export class UsageError extends Error {}
/** Flags `send`, `ask` and `register` build content from. */
export type Flags = {
  title?: string;
  body?: string;
  input?: string;
  'body-file'?: string;
  kind?: string;
  field?: string[];
  action?: string[];
  block?: string[];
  file?: string[];
  annotate?: string[];
  review?: boolean;
  'reply-to'?: string;
  team?: string;
  deadline?: string;
};
type Json = Record<string, unknown>;
const problems = (error: z.ZodError) =>
  error.issues.map((i) => (i.path.length ? i.path.join('.') + ': ' : '') + i.message).join('; ');
export const titleCase = (id: string) =>
  id
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(' ');
const fieldTypes = [
  'text',
  'textarea',
  'number',
  'boolean',
  'select',
  'multiselect',
  'date',
  'secret',
  'file',
  'secret-file',
];
/** `ID[?]:TYPE[:LABEL[:CHOICES]]`; required unless ID ends with `?`. */
export function fieldSpec(spec: string): Field {
  const [raw = '', type = '', label, ...rest] = spec.split(':');
  const choices = rest.join(':');
  const bad = (why: string) => new UsageError(`--field ${spec}: ${why}`);
  if (!fieldTypes.includes(type))
    throw bad(`use ID[?]:TYPE[:LABEL[:CHOICES]], TYPE one of ${fieldTypes.join(', ')}.`);
  const select = type === 'select' || type === 'multiselect';
  if (select && !choices) throw bad(`${type} needs CHOICES.`);
  if (!select && choices)
    throw bad('only select and multiselect take CHOICES; LABEL cannot hold ":".');
  const id = raw.replace(/\?$/, '');
  const parsed = fieldSchema.safeParse({
    id,
    label: label || titleCase(id),
    required: !raw.endsWith('?'),
    ...(type === 'secret-file' ? { type: 'file', secret: true, maxItems: 1 } : { type }),
    ...(type === 'secret' && { maxLength: 16000 }),
    ...(select && {
      options: choices.split(',').map((choice) => {
        const [value, ...name] = choice.split('=');
        return { value: value.trim(), label: name.join('=').trim() || value.trim() };
      }),
    }),
  });
  if (!parsed.success) throw bad(problems(parsed.error));
  return parsed.data;
}
/** `ID[:LABEL]`: a one-tap answer with no values. */
export function actionSpec(spec: string): RequestAction {
  const [id, ...label] = spec.split(':');
  const parsed = actionSchema.safeParse({
    id,
    label: label.join(':') || titleCase(id),
    values: {},
  });
  if (!parsed.success) throw new UsageError(`--action ${spec}: ${problems(parsed.error)}`);
  return parsed.data;
}
/** RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF; blank lines are skipped. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (text[i + 1] === '"') cell += text[++i];
      else quoted = false;
    } else if (c === '"' && !cell) quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      rows.push([...row, cell]);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (quoted) throw new UsageError('The CSV has an unterminated quote.');
  if (cell || row.length) rows.push([...row, cell]);
  return rows.filter((r) => r.length > 1 || r[0]);
}
const languages: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'javascript',
  '.py': 'python',
  '.sql': 'sql',
  '.json': 'json',
};
type Read = (path: string) => Promise<string>;
/** `TYPE=PATH`: an image block names its file; the others read it (`-` is stdin). */
async function blockSpec(spec: string, read: Read): Promise<{ block: Json; image?: string }> {
  const at = spec.indexOf('=');
  const [type, path] = [spec.slice(0, at), spec.slice(at + 1)];
  const bad = (why: string) => new UsageError(`--block ${spec}: ${why}`);
  if (at < 1 || !path || !reviewBlockTypes.some((t) => t === type))
    throw bad(`use TYPE=PATH, TYPE one of ${reviewBlockTypes.join(', ')}.`);
  const title = path === '-' ? undefined : basename(path);
  if (type === 'image') {
    if (path === '-') throw bad('images need a file path.');
    return { block: { type, alt: basename(path) }, image: path };
  }
  const text = await read(path);
  if (type === 'table') {
    const [columns = [], ...rows] = parseCsv(text);
    if (!columns.length || columns.length > 12) throw bad('a table has 1 to 12 columns.');
    if (rows.length > 100) throw bad('a table has at most 100 rows.');
    return { block: { type, title, columns, rows } };
  }
  if (type === 'json')
    try {
      JSON.parse(text);
    } catch {
      throw bad('the file is not valid JSON.');
    }
  const language = type === 'code' ? languages[extname(path).toLowerCase()] || 'text' : undefined;
  return { block: { type, title, language, text } };
}
/** A message from `-i` input and flags, validated before any upload. */
export async function composeMessage(
  flags: Flags,
  base: Json | undefined,
  waiting: boolean,
  stdin: () => Promise<string>,
) {
  if (
    [flags['body-file'], ...(flags.block || []).map((b) => b.split('=')[1])].filter(
      (p) => p === '-',
    ).length > 1
  )
    throw new UsageError('Only one option can read stdin.');
  const read: Read = (path) => (path === '-' ? stdin() : readFile(path, 'utf8'));
  const input: Json = base
    ? { ...base }
    : { title: 'A message for you', body: '', kind: 'message' };
  if (flags.title !== undefined) input.title = flags.title;
  if (flags.team) input.team = flags.team;
  if (flags.body !== undefined && flags['body-file'])
    throw new UsageError('Use --body or --body-file, not both.');
  if (flags.body !== undefined) input.body = flags.body;
  if (flags['body-file']) input.body = await read(flags['body-file']);
  if (flags.kind) {
    if (!['message', 'report', 'files'].includes(flags.kind))
      throw new UsageError('--kind is message, report or files.');
    input.kind = flags.kind;
  }
  // In -i input, an annotations field may name a local PDF `file`, relative to the input file.
  const from = flags.input ? dirname(resolve(flags.input)) : '.';
  const pdfs: { field: Json; path: string }[] = [];
  const pdf = (path: string, where: string) => {
    if (fileType(path) !== 'application/pdf') throw new UsageError(`${where}: use a PDF file.`);
    return path;
  };
  const named = ((input.fields as Json[]) || []).map((field) => {
    if (field.type !== 'annotations' || typeof field.file !== 'string') return field;
    const { file, ...rest } = field;
    const copy = { ...rest };
    pdfs.push({ field: copy, path: resolve(from, pdf(file as string, `fields.${field.id}`)) });
    return copy;
  });
  if ((flags.annotate?.length ?? 0) > 1) throw new UsageError('Use --annotate once per message.');
  const fields = [...(named as Field[]), ...(flags.field || []).map(fieldSpec)];
  for (const path of flags.annotate || []) {
    const field = { id: 'comments', type: 'annotations', label: 'Comments', required: false };
    fields.push(field as Field);
    pdfs.push({ field, path: pdf(path, `--annotate ${path}`) });
  }
  const actions = [...((input.actions as Json[]) || []), ...(flags.action || []).map(actionSpec)];
  if (waiting && !fields.length && !actions.length && !input.schema && !input.questions)
    fields.push({ id: 'reply', type: 'textarea', label: 'Your reply', required: true });
  // Flag actions answer with no values, so they cannot complete a required field or question.
  if (flags.action?.length && (input.questions || fields.some((f) => f.required)))
    throw new UsageError(
      '--action needs every field optional (ID?), none secret or file, and no questions.',
    );
  if (fields.length) input.fields = fields;
  if (actions.length) input.actions = actions;
  if (fields.length || actions.length || input.questions || waiting) input.kind = 'form';
  // In -i input, an image block may name a local `file` to upload, relative to the input file.
  const images: { block: Json; path: string }[] = [];
  const blocks = ((input.blocks as Json[]) || []).map((block) => {
    if (block.type !== 'image' || typeof block.file !== 'string') return block;
    const { file, ...rest } = block;
    const copy = { alt: basename(file as string), ...rest };
    images.push({ block: copy, path: resolve(from, file as string) });
    return copy;
  });
  for (const spec of flags.block || []) {
    const { block, image } = await blockSpec(spec, read);
    blocks.push(block);
    if (image) images.push({ block, path: image });
  }
  if (blocks.length) input.blocks = blocks;
  if (flags.review) input.requiresReview = true;
  if (flags['reply-to']) input.replyTo = flags['reply-to'];
  if (flags.deadline) {
    if (input.expiresAt || input.expiresIn)
      throw new UsageError('Use --deadline or expiresAt, not both.');
    input.expiresIn = duration(flags.deadline);
  }
  // Each path uploads once, even when it is a --file and an image block or annotated PDF.
  const paths = [
    ...new Set(
      [...(flags.file || []), ...images.map((i) => i.path), ...pdfs.map((p) => p.path)].map((p) =>
        resolve(p),
      ),
    ),
  ];
  const attached = (input.attachments as Attachment[]) || [];
  const fill = (files: Attachment[]) => {
    for (const { block, path } of images)
      block.attachmentId = files[paths.indexOf(resolve(path))].id;
    for (const { field, path } of pdfs) field.attachmentId = files[paths.indexOf(resolve(path))].id;
    input.attachments = [...attached, ...files];
  };
  fill(
    paths.map((p) => ({ id: crypto.randomUUID(), name: basename(p), size: 0, type: fileType(p) })),
  );
  const parsed = messageInputSchema.safeParse(input);
  if (!parsed.success) throw new UsageError(problems(parsed.error));
  return {
    input: input as MessageRequest,
    fields: parsed.data.kind === 'secret' ? [] : parsed.data.fields,
    /** Uploads the files and points image blocks and annotations fields at them. */
    async attach(client: Herald) {
      const files: Attachment[] = [];
      for (const path of paths) files.push(await uploadPath(client, path));
      fill(files);
    },
  };
}
/**
 * `--out [FIELD=]PATH` for secret and file fields; a bare PATH needs exactly one. With `all`,
 * every secret field needs one.
 */
export function outputs(specs: string[], fields: Field[], all: boolean): Output[] {
  const eligible = fields.filter((f) => f.type === 'secret' || f.type === 'file');
  const list = specs.map((spec) => {
    const named = /^([a-zA-Z][a-zA-Z0-9_-]{0,63})=(.+)$/.exec(spec);
    if (named) {
      if (!eligible.some((f) => f.id === named[1]))
        throw new UsageError(`--out ${named[1]}=: no secret or file field has that ID.`);
      return { field: named[1], path: named[2] };
    }
    if (eligible.length !== 1)
      throw new UsageError(
        'Use --out FIELD=PATH unless there is exactly one secret or file field.',
      );
    return { field: eligible[0].id, path: spec };
  });
  if (new Set(list.map((o) => o.field)).size !== list.length)
    throw new UsageError('Give each field one --out.');
  if (new Set(list.map((o) => resolve(o.path))).size !== list.length)
    throw new UsageError('Give each --out its own path.');
  const missing = eligible.filter((f) => isSecret(f) && !list.some((o) => o.field === f.id));
  if (all && missing.length)
    throw new UsageError(`Secret fields need --out: ${missing.map((f) => f.id).join(', ')}.`);
  return list;
}
type Token = { kind: string; name?: string; value?: string };
/** A destination from `-i` input and flags; each `--field` belongs to the `--type` before it. */
export function composeDestination(
  base: Json | undefined,
  flags: { target?: string; webhook?: string; description?: string },
  tokens: Token[],
): DestinationRegistration {
  const input: Json = { ...base };
  if (flags.target) input.key = flags.target;
  if (flags.webhook) input.transport = { kind: 'webhook', url: flags.webhook };
  if (flags.description !== undefined) input.description = flags.description;
  const types = [...((input.types as Json[]) || [])];
  let current: { fields: Field[] } | undefined;
  for (const token of tokens) {
    if (token.kind !== 'option' || !token.value) continue;
    if (token.name === 'type') {
      const [id, ...label] = token.value.split(':');
      current = { fields: [] };
      types.push({ id, label: label.join(':') || titleCase(id), ...current });
    } else if (token.name === 'field') {
      if (!current) throw new UsageError('Each --field follows the --type it belongs to.');
      const field = fieldSpec(token.value);
      if (field.type === 'secret' || field.type === 'file')
        throw new UsageError(
          `--field ${token.value}: destination types take no secret or file fields.`,
        );
      current.fields.push(field);
    }
  }
  input.types = types;
  if (!types.length)
    throw new UsageError('Usage: herald register --type ID [--field SPEC]... or -i FILE');
  const parsed = destinationSchema.safeParse(input);
  if (!parsed.success) throw new UsageError(problems(parsed.error));
  return input as DestinationRegistration;
}
