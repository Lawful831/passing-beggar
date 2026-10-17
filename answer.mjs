#!/usr/bin/env node
// Answer the task queue. Appending is the write; the server collapses by id.
//   node answer.mjs                 list open tasks
//   node answer.mjs --all           list everything
//   node answer.mjs --refuse <id>   public refusal, no answer given
//   node answer.mjs <id> "the answer"
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(DIR, 'data', 'tasks.jsonl');

const byId = new Map();
if (fs.existsSync(FILE)) {
  for (const line of fs.readFileSync(FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { const t = JSON.parse(line); byId.set(t.id, { ...(byId.get(t.id) || {}), ...t }); } catch {}
  }
}
const all = [...byId.values()];
const argv = process.argv.slice(2);

if (!argv.length || argv[0] === '--open') {
  const open = all.filter((t) => t.status === 'queued');
  console.log(`${open.length} open, ${all.length} total`);
  for (const t of open) console.log(`  ${t.id}  ${t.ts}  ${t.task.slice(0, 160)}`);
  process.exit(0);
}
if (argv[0] === '--all') {
  for (const t of all) console.log(`  [${t.status}] ${t.id}  ${t.task.slice(0, 140)}${t.answer ? '\n      -> ' + t.answer.slice(0, 200) : ''}`);
  process.exit(0);
}

const refuse = argv[0] === '--refuse';
const id = refuse ? argv[1] : argv[0];
const body = refuse ? (argv[2] || 'Not something I will do. Sorry, and thank you anyway.') : argv.slice(1).join(' ');
if (!id || !body) {
  console.error('usage: node answer.mjs <id> "answer"   |   node answer.mjs --refuse <id> "why"');
  process.exit(1);
}
if (!byId.has(id)) { console.error('no such task id:', id); process.exit(1); }
fs.appendFileSync(FILE, JSON.stringify({
  id,
  status: refuse ? 'refused' : 'done',
  answer: body,
  answered_at: new Date().toISOString(),
}) + '\n');
console.log(`${refuse ? 'refused' : 'answered'} ${id}`);
