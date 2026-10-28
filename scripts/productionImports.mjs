import { isBuiltin } from 'node:module';

/** Find external static imports/reexports in emitted JavaScript without running it. */
export async function findExternalProductionImports(source) {
  // Prepack builds this module before the consumer guard runs. Reuse the project's scanner
  // so indentation, multiline declarations and inert text follow one tested lexical contract.
  const { extractModuleSpecifiers } = await import('../dist/scanner/moduleSpecifiers.js');

  return extractModuleSpecifiers(source)
    .filter(({ kind }) => kind === 'import' || kind === 'export-from')
    .map(({ specifier }) => specifier)
    .filter((specifier) => !isBuiltin(specifier) && !/^\.\.?\//.test(specifier));
}
