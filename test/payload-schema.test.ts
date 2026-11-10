import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Ajv from 'ajv/dist/2020';

// Spec M3 / Q2: docs/payload-schema.json must accept every native golden batch, so the doc
// can't drift from what the plugin actually sends.
const ROOT = new URL('..', import.meta.url).pathname;
const GOLDEN_DIRS = [
  'packages/capacitor/android/src/test/resources/golden',
  'packages/capacitor/ios/core-test/Tests/golden',
];

const validate = new Ajv({ allErrors: true, validateFormats: false }).compile(
  JSON.parse(readFileSync(join(ROOT, 'docs/payload-schema.json'), 'utf8')),
);

describe('docs/payload-schema.json', () => {
  for (const dir of GOLDEN_DIRS) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.json'))) {
      it(`accepts ${dir.split('/')[2]} ${file}`, () => {
        validate(JSON.parse(readFileSync(join(ROOT, dir, file), 'utf8')));
        expect(validate.errors ?? []).toEqual([]);
      });
    }
  }

  it('rejects a 4.x-style event name and nested attributes', () => {
    const golden = JSON.parse(readFileSync(join(ROOT, GOLDEN_DIRS[0], 'batch.json'), 'utf8'));
    golden.events[0].eventName = 'page_load';
    golden.events[0].attributes = { nested: { a: 1 } };
    expect(validate(golden)).toBe(false);
  });
});
