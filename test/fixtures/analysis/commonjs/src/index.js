const pad = require('left-pad');
const missing = require('missing-cjs');
// require('fake-comment-pkg');
const note = "require('fake-string-pkg')";
const template = `require('fake-template-pkg')`;
const pattern = /require\('fake-regex-pkg'\)/;
const dynamicName = 'some-lazy-pkg';
const lazy = require(dynamicName);
const prop = obj.require('fake-prop-pkg');

export const value = pad(missing);
