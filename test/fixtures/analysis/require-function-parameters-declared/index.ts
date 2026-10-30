require('real-before');
function bound(first = require('fake-default'), { value: require } = loader) {
  require('fake-body');
  function nested() { require('fake-inherited'); }
  const text = `${function () { require('fake-template'); }}`;
  import('real-module');
}
function keyOnly({ require: loader }, value = require('real-default')) { require('real-loader'); }
function typed(value: require) { require('real-type'); }
function computed({ [require('real-key')]: value }) {}
require('real-after');
