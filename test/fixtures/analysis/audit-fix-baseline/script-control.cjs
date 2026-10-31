// Explicit script control for await/division and expression ownership.
var await = 4; await / require('cjs-await-real') / 2;
const classOwner = () => class {} / require('cjs-class-real') / 2;
