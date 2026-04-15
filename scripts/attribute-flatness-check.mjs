#!/usr/bin/env node
// Asserts that any JSON fixture under test/fixtures/ containing `attributes`
// only has primitive (string | number | boolean) values in them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;

function walk(dir) {
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.json') && full.includes('/fixtures/')) out.push(full);
  }
  return out;
}

function checkAttributes(file, events) {
  let violations = 0;
  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const attrs = ev.attributes;
    if (!attrs || typeof attrs !== 'object') continue;
    for (const [k, v] of Object.entries(attrs)) {
      const t = typeof v;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') {
        console.error(`${file}  attributes[${k}] is ${t} — must be string|number|boolean`);
        violations++;
      }
    }
  }
  return violations;
}

const files = walk(ROOT);
let total = 0;
let totalViolations = 0;

for (const file of files) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    continue;
  }
  const events = data?.data?.events;
  if (!Array.isArray(events)) continue;
  total++;
  totalViolations += checkAttributes(file, events);
}

if (totalViolations > 0) {
  console.error(`\n[attribute-flatness-check] FAIL: ${totalViolations} nested attribute value(s)`);
  process.exit(1);
}

console.log(`[attribute-flatness-check] OK — scanned ${total} fixture payload(s)`);
