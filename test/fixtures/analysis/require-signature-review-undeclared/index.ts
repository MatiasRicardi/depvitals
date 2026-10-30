declare function local(require: Loader)
/require('fake-regex')/.test('');
require('real-first');
function overloaded(require: Loader)
function overloaded(value: Loader) { require('real-implementation'); }
function generic(value = make<string, require, Other>()) { require('real-generic'); }
function bound(value = make<string, require, Other>(), require: Loader) { require('fake-bound'); }
function normal(require: Loader)
{ require('fake-newline'); }
require('real-after');
