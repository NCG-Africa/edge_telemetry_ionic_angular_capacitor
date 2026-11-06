#!/usr/bin/env node
// Spec V2: prints the root CHANGELOG section for a version (release.yml → GitHub Release body).
// A prerelease (`5.0.0-rc.1`) falls back to its base version's section (`## 5.0.0`).
import { readFileSync } from 'node:fs';

export function releaseNotes(changelog, version) {
  const section = (v) => {
    const lines = changelog.split('\n');
    const start = lines.indexOf(`## ${v}`);
    if (start < 0) return '';
    const end = lines.findIndex((l, i) => i > start && l.startsWith('## '));
    return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
  };
  return section(version) || section(version.replace(/-.*$/, ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const notes = releaseNotes(readFileSync('CHANGELOG.md', 'utf8'), process.argv[2] ?? '');
  if (notes) console.log(notes);
}
