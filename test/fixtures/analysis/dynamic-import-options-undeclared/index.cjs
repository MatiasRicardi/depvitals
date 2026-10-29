import('real-with', { with: { type: 'json' } });
import('real-assert', /* options */ { 'assert': { 'type': 'json' } },);
import('real-outer', {
  note: { text: "import('fake-text')" },
  with: { type: 'fake-attribute' },
  callback: require('real-nested',),
});
require('fake-require', { with: { type: 'json' } });
import('fake-computed' + suffix, { with: { type: 'json' } });
import('fake-variable', options);
import('fake-extra', makeOptions(import('real-extra',)));
import('fake-array', [require('real-array',)]);
require('real-after',);
