// Ambient Node.js globals come from the declared `@types/node` package, so there is no import
// statement for a lexical scanner to observe.
const mode = process.env.NODE_ENV ?? 'development';

console.log(`running in ${mode}`);
