/** Internal input reader for the canonical tsconfig in the selected scan root. */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type RootTsconfig =
  | { readonly kind: 'absent' | 'skipped' }
  | { readonly kind: 'usable'; readonly extends: string | readonly string[] | undefined };

export const ROOT_TSCONFIG_FILENAME = 'tsconfig.json';
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Select only an exact root entry from the scan's existing directory snapshot. */
export async function readRootTsconfig(
  root: string,
  rootEntries: readonly string[],
): Promise<RootTsconfig> {
  if (!rootEntries.includes(ROOT_TSCONFIG_FILENAME)) return { kind: 'absent' };

  const path = join(root, ROOT_TSCONFIG_FILENAME);
  try {
    if (!(await lstat(path)).isFile()) return { kind: 'skipped' };
    const text = UTF8.decode(await readFile(path));
    return readDocument(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    return { kind: 'skipped' };
  }
}

function readDocument(text: string): RootTsconfig {
  const parsed: unknown = JSON.parse(stripJsoncTrivia(text));
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'skipped' };
  }

  const value = (parsed as Record<string, unknown>)['extends'];
  if (value === undefined || typeof value === 'string') return { kind: 'usable', extends: value };
  if (Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string')) {
    return { kind: 'usable', extends: value };
  }
  return { kind: 'skipped' };
}

/**
 * Leave JSON.parse in charge of JSON grammar, and remove only comment text and an eligible
 * trailing comma. Check the decoded top-level key before JSON.parse can collapse duplicates.
 */
function stripJsoncTrivia(text: string): string {
  const chunks: string[] = [];
  let segmentStart = 0;
  let trailingComma: number | undefined;
  let depth = 0;
  let rootObject = false;
  let seenExtends = false;
  let previous: string | undefined;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '/' && (next === '/' || next === '*')) {
      chunks.push(text.slice(segmentStart, i), ' ');
      i = commentEnd(text, i, next) - 1;
      segmentStart = i + 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') continue;

    if (ch === '}' || ch === ']') {
      if (trailingComma !== undefined) chunks[trailingComma] = '';
      depth--;
    } else if (ch === '{' || ch === '[') {
      if (previous === undefined) rootObject = ch === '{';
      depth++;
    } else if (ch === '"') {
      const end = stringEnd(text, i);
      if (
        rootObject &&
        depth === 1 &&
        (previous === '{' || previous === ',') &&
        JSON.parse(text.slice(i, end)) === 'extends'
      ) {
        if (seenExtends) throw new SyntaxError('Duplicate root extends');
        seenExtends = true;
      }
      i = end - 1;
    }

    trailingComma = undefined;
    if (ch === ',' && previous !== '{' && previous !== '[' && previous !== ',') {
      chunks.push(text.slice(segmentStart, i), ',');
      trailingComma = chunks.length - 1;
      segmentStart = i + 1;
    }
    previous = ch;
  }

  chunks.push(text.slice(segmentStart));
  return chunks.join('');
}

function commentEnd(text: string, start: number, marker: '*' | '/'): number {
  if (marker === '*') {
    const closing = text.indexOf('*/', start + 2);
    if (closing === -1) throw new SyntaxError('Unterminated block comment');
    return closing + 2;
  }

  let end = start + 2;
  while (end < text.length && text[end] !== '\r' && text[end] !== '\n') end++;
  return end;
}

function stringEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '"') return i + 1;
    if (text[i] === '\\') i++;
  }
  throw new SyntaxError('Unterminated JSON string');
}
