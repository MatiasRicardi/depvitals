import 'real-module';
require('real-before');
const single = require => require('fake-arrow');
const typed = async (require: Loader): Promise<Result> => {
  require('fake-arrow');
  import('real-inside');
};
const expression = (require) => require('fake-arrow') as Result
require('real-asi');
const callback = (cb = (require) => require('fake-default')) => require('real-default');
const object = {
  [require('real-key')](require) {
    require('fake-method');
    function nested() { require('fake-inherited'); }
  },
  async *run(first = require('fake-default'), require) { require('fake-method'); },
  require(value: require) { require('real-method-name'); },
};
class C {
  constructor(public require: Loader) { require('fake-class'); }
  static [require('real-key')](require: Loader): Result { require('fake-class'); }
  *run(require) { const nested = () => require('fake-inherited'); }
  async *iterate(require) { require('fake-class'); }
  next({ require: load }) { require('real-key-control'); }
}
require('real-after');
