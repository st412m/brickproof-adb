#!/usr/bin/env node
'use strict';
/**
 * A stand-in for adb in wiring tests, started as `node fake-adb.js <adb args>`
 * (adb.js useTestRunner). It does not know adb: it answers from rules.
 *
 * FAKE_ADB_RULES  JSON file: [{ match, stdout, stdoutFile, stderr, code,
 *                 delayMs, waitFor, echo, once }]. The first rule whose
 *                 `match` (a regex) matches the arguments joined by spaces
 *                 answers. `echo` prints the argv as JSON; `once` answers one
 *                 call only; `waitFor` (a path) answers once that file
 *                 exists, so a test decides when, not the clock. No rule:
 *                 stderr and exit 1.
 * FAKE_ADB_LOG    every call's argv is appended as a JSON line.
 */
const fs = require('fs');

const args = process.argv.slice(2);
const joined = args.join(' ');
if (process.env.FAKE_ADB_LOG) fs.appendFileSync(process.env.FAKE_ADB_LOG, JSON.stringify(args) + '\n');

let rules = [];
try { rules = JSON.parse(fs.readFileSync(process.env.FAKE_ADB_RULES, 'utf8')); } catch {}
// A rule with once: true answers the first matching call only.
const used = i => `${process.env.FAKE_ADB_RULES}.used-${i}`;
const index = rules.findIndex((r, i) => new RegExp(r.match).test(joined) && !(r.once && fs.existsSync(used(i))));
const rule = rules[index];
if (rule && rule.once) fs.writeFileSync(used(index), '');
if (!rule) {
  process.stderr.write(`fake adb: no rule for: ${joined}\n`);
  process.exit(1);
}

function answer() {
  if (rule.stderr) process.stderr.write(rule.stderr);
  if (rule.echo) process.stdout.write(JSON.stringify(args));
  else if (rule.stdoutFile) process.stdout.write(fs.readFileSync(rule.stdoutFile));
  else if (rule.stdout) process.stdout.write(rule.stdout);
  process.exitCode = rule.code || 0;
}

if (rule.waitFor) {
  const poll = setInterval(() => { if (fs.existsSync(rule.waitFor)) { clearInterval(poll); answer(); } }, 10);
} else if (rule.delayMs) setTimeout(answer, rule.delayMs);
else answer();
