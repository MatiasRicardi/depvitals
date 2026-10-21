// `process` is typed by the ambient package named in "types": ["node"].
const mode = process.env.NODE_ENV ?? 'development';

console.log(`running in ${mode}`);
