// Explicit script control for await/division and expression ownership.
var await = 4; await / require('trailing-real') / 2;
const classOwner = () => class {} / require('arrow-real') / 2;
