import { isBuiltin } from 'node:module';

/** Extract all supported literal module loads from emitted code without executing it. */
export async function findProductionImports(source) {
  const { extractModuleSpecifiers } = await import('../dist/scanner/moduleSpecifiers.js');
  return extractModuleSpecifiers(source, { module: true }).map(({ specifier }) => specifier);
}

export function isExternalProductionImport(specifier) {
  return !isBuiltin(specifier) && !/^\.\.?\//.test(specifier);
}

/** Static imports/reexports, literal dynamic imports and unshadowed literal requires. */
export async function findExternalProductionImports(source) {
  return (await findProductionImports(source)).filter(isExternalProductionImport);
}
