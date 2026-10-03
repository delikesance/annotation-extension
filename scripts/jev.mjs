#!/usr/bin/env node
/**
 * Development-time decision helper: ask Jev (TypeSafe System One) a typed question.
 * Not part of the extension: nothing under scripts/ is shipped in dist/.
 *
 *   npm run jev -- choice "Which fits?" --option a="desc" --option b="desc" --state "text or JSON"
 *   npm run jev -- noul "Is this a flaky test?" --state '{"output":"..."}'
 *
 * Prints the answer (choice + probabilities, or noul probability). Key: TYPESAFE_API_KEY (.env).
 */
import { pathToFileURL } from 'node:url';

const ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export async function ask(state, questions, { model = 'jev-latest' } = {}) {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY is not set (put it in .env)');
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, state, questions })
  });
  if (!res.ok) throw new Error(`Jev HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()).answers;
}

export const choice = (instructions, criteria) => ({ type: 'choice', instructions, criteria });
export const noul = (instructions, criteria) => ({ type: 'noul', instructions, criteria });

async function cli(argv) {
  const [kind, question, ...rest] = argv;
  if (!['choice', 'noul'].includes(kind) || !question) {
    console.error('usage: jev.mjs <choice|noul> "<question>" [--option name=desc ...] [--state "..."]');
    process.exit(2);
  }
  let state = '';
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--state') state = rest[++i];
    else if (rest[i] === '--option') {
      const [name, ...desc] = rest[++i].split('=');
      options[name] = desc.join('=') || null;
    }
  }
  try { state = JSON.parse(state); } catch (_) {}
  const q = kind === 'choice' ? choice(question, options) : noul(question);
  const answers = await ask(state, { q: q });
  console.log(JSON.stringify(answers.q, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
}
