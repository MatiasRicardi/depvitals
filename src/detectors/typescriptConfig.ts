/** Lexical usage facts from the selected root's validated tsconfig extends values. */
import { isExactPackageRoot } from '../config/ignoreDependencies.js';
import { ROOT_TSCONFIG_FILENAME, type RootTsconfig } from '../config/readRootTsconfig.js';
import { jsonPointer, type ConfigOccurrence } from '../core/evidence.js';

const INVALID_SUBPATH_CHARACTER = /[^A-Za-z0-9._-]/u;

function selectedPackageRoot(value: string): string | undefined {
  const segments = value.split('/');
  const rootLength = value.startsWith('@') ? 2 : 1;
  const packageName = segments.slice(0, rootLength).join('/');
  if (!isExactPackageRoot(packageName)) return undefined;
  if (
    segments
      .slice(rootLength)
      .some(
        (segment) =>
          segment === '' ||
          segment === '.' ||
          segment === '..' ||
          INVALID_SUBPATH_CHARACTER.test(segment),
      )
  ) {
    return undefined;
  }
  return packageName;
}

/** Preserve the original value and array index without resolving a selector or its config. */
export function collectTypescriptConfigUsage(
  config: RootTsconfig,
  declaredPackageNames: ReadonlySet<string>,
): readonly ConfigOccurrence[] {
  if (config.kind !== 'usable' || config.extends === undefined) return [];
  const occurrences: ConfigOccurrence[] = [];
  const add = (value: string, index?: number): void => {
    const packageName = selectedPackageRoot(value);
    if (packageName === undefined || !declaredPackageNames.has(packageName)) return;
    occurrences.push({
      packageName,
      evidence: {
        kind: 'config',
        detector: 'typescript',
        file: ROOT_TSCONFIG_FILENAME,
        pointer:
          index === undefined ? jsonPointer('extends') : jsonPointer('extends', String(index)),
        value,
      },
    });
  };

  if (typeof config.extends === 'string') {
    add(config.extends);
  } else {
    for (const [index, value] of config.extends.entries()) add(value, index);
  }
  return occurrences;
}
