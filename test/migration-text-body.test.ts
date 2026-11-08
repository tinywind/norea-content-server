import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMigrationTextBody } from '../src/migration-text-body.ts';

for (const body of [
  'Plain synthetic text',
  '<p style="color:#333" title="a > b">Text &lt;img src="example"&gt;</p><br><p>Next paragraph.</p>',
  '<!doctype html><html><body><style>p { color: red; }</style><p>Body.</p></body></html>',
  '<p>Body.</p><!-- <img src="not-rendered"> -->',
]) test('accepts self-contained text markup: ' + body.slice(0, 30), () => {
  assert.equal(isMigrationTextBody(Buffer.from(body)), true);
});

for (const body of [
  '<IMG SRC="https://fixture.invalid/a.png">',
  '<picture><source srcset="a.webp"><img src="a.png"></picture>',
  '<svg><image href="a.png"></image></svg>',
  '<p background="a.png">Body.</p>',
  '<p style="background:url(a.png)">Body.</p>',
  '<p style="background:u&#114;l&lpar;a.png&rpar;">Body.</p>',
  '<p style="background:u\\72l(a.png)">Body.</p>',
  '<style>p { background: image-set("a.png" 1x); }</style>',
  '<style>@import "remote.css";</style>',
  '<p style="color:/**/red">Body.</p>',
  '<script>document.createElement("img")</script>',
  '<a href="java&#x09;script:createImage()">Open</a>',
  '<p onclick="createImage()">Body.</p>',
  '<iframe srcdoc="image"></iframe>',
  '<p title="unterminated>Body.',
]) test('rejects unknown body-only resource coverage: ' + body.slice(0, 45), () => {
  assert.equal(isMigrationTextBody(Buffer.from(body)), false);
});

test('rejects invalid text encoding and Markdown image references', () => {
  assert.equal(isMigrationTextBody(Uint8Array.from([0xff])), false);
  assert.equal(isMigrationTextBody(Buffer.from('![page](image.png)'), 'markdown'), false);
  assert.equal(isMigrationTextBody(Buffer.from('')), false);
});
