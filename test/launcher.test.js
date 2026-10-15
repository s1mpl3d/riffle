// node test/launcher.test.js
const assert = require('assert');
const Module = require('module');
const load = Module._load;
Module._load = (req, ...rest) => req === 'electron' ? { app: { getName: () => 'Riffle' } } : load(req, ...rest);
const { quoteExec } = require('../launcher');

assert.strictEqual(quoteExec('/home/a/Riffle.AppImage'), '"/home/a/Riffle.AppImage"');
assert.strictEqual(quoteExec('/home/a b/"x"$y`z\\.AppImage'), '"/home/a b/\\"x\\"\\$y\\`z\\\\.AppImage"');
assert.strictEqual(quoteExec('/tmp/100%/R.AppImage'), '"/tmp/100%%/R.AppImage"');
console.log('launcher ok');
