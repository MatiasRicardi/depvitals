const first = require /* tag trivia */ `require('fake-text')${('fake-tag')}${require('real-inner')}`;
const nested = require`outer${require`inner${('fake-nested')}`}`;
const member = obj.require`text${('fake-member')}`;
const divided = first / require('real-divisor') / 2;
require('real-after');
