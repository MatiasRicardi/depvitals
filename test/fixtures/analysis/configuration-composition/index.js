// Static input only: no source, template tag, config or lifecycle is executed.
import 'static-used';
import 'peer-used';
import 'optional-used';
import 'root-self/feature';
await /don't require('regex-fake')/;
const object = { import: 1 };
const from = 1;
from
'property-fake';
const arrow = () => function () {} / require('arrow-used',) / 2;
const tagged = require`${('tag-decoy')}${require('template-used')}`;
const shadow = (require) => require('shadow-fake');
require('selected-missing');
require('selected-missing-extra');
require('genuine-missing');
throw new Error('source must never execute');
