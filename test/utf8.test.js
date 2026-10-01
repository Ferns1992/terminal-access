// Verifies the exact bug this rewrite fixes: base64 terminal payloads must
// decode to real UTF-8 strings, not binary (one-char-per-byte) strings.
const assert = require('assert');

// Mirror of decodeB64() in public/js/app.js
const utf8Decoder = new TextDecoder('utf-8');
function decodeB64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return utf8Decoder.decode(bytes);
}

let pass = 0, fail = 0;
function check(name, actual, expected) {
  try {
    assert.strictEqual(actual, expected);
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
    pass++;
  } catch (e) {
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`);
    console.log(`       got:      ${JSON.stringify(actual)}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    fail++;
  }
}

console.log('\nUTF-8 decoding (the character-mismatch fix)\n');

// The classic broken case: a box-drawing char is 3 UTF-8 bytes.
const boxDrawing = '─';
const boxBytes = Buffer.from(boxDrawing, 'utf8');
console.log(`  (${boxDrawing} is ${boxBytes.length} bytes as UTF-8)\n`);

check('box-drawing char survives the round trip',
  decodeB64(boxBytes.toString('base64')), boxDrawing);

// atob() is the old buggy path - prove it corrupts multibyte text.
const viaAtob = atob(boxBytes.toString('base64'));
check('old atob() path produced 3 junk chars (the bug)',
  viaAtob.length, 3);
check('new decodeB64() produced exactly 1 char (the fix)',
  decodeB64(boxBytes.toString('base64')).length, 1);

const samples = [
  ['box drawing block', '┌─┬─┐ │ └─┴─┘'],
  ['midnight dot', '⠋⠙⠹'],
  ['accented latin', 'café naïve façade'],
  ['emoji', '🚀 🎉 ⚡ 🖥️'],
  ['CJK', '日本語 中文 한국어'],
  ['colour codes + text', '\x1b[32mgreen\x1b[0m'],
  ['plain ascii', 'total 42'],
  ['empty payload', '']
];

samples.forEach(([label, s]) => {
  check(label, decodeB64(Buffer.from(s, 'utf8').toString('base64')), s);
});

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m\n`);
process.exit(fail === 0 ? 0 : 1);
