#!/usr/bin/env node
/**
 * Development-time evaluation: Jev judges a corpus, the extension's local heuristics are
 * measured against those judgments.
 *
 *   npm run eval:heuristics            # ask Jev, print agreement + disagreements, refresh the snapshot
 *   npm run eval:heuristics -- --offline   # reuse the stored snapshot (no API call)
 *
 * The snapshot (test/fixtures/jev-labels.json) lets the unit tests check the heuristics offline.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { ask, choice, noul } from './jev.mjs';

const require = createRequire(import.meta.url);
const root = new URL('../', import.meta.url);
const heldout = process.argv.includes('--heldout'); // corpus never used to tune the heuristics
const corpusName = heldout ? 'heldout' : 'heuristics';
const corpus = JSON.parse(fs.readFileSync(new URL(`test/fixtures/${corpusName}-corpus.json`, root), 'utf8'));
const labelsPath = new URL(`test/fixtures/${heldout ? 'heldout-labels' : 'jev-labels'}.json`, root);
const VAGUE_THRESHOLD = 0.85; // Jev P(vague) from which a comment counts as too vague
const offline = process.argv.includes('--offline');

const Insights = require('../src/sidepanel/insights.js');
const UI = require('../src/content/ui-manager.js');

export const COMMENT_QUESTIONS = {
  type: choice('What kind of change does this UI feedback comment request on the element?', {
    bug: 'Something is broken or does not work as intended',
    style: 'A visual, layout, spacing, size or color change',
    text: 'A wording, copy or content change'
  }),
  vague: noul('Is the comment too vague for a developer to act on without asking a follow-up question?', {
    true: 'No concrete target value, state or desired outcome is given',
    false: 'States a specific problem or desired change that can be implemented'
  })
};
export const DOM_QUESTIONS = {
  newState: noul('Do these DOM changes show that the user moved to a different state of the interface (a menu, dialog, drawer, tab, route or main content being replaced) rather than ambient updates?', {
    true: 'A distinct UI state appeared or replaced another: opened menu or panel, modal, new tab content, new page content',
    false: 'Ambient or incidental updates: clock, ticker, animation, loading spinner, ad, counter, tooltip, small text refresh'
  })
};

async function label() {
  if (offline) return JSON.parse(fs.readFileSync(labelsPath, 'utf8'));
  const labels = { comments: {}, domChanges: {} };
  for (const text of corpus.comments) {
    const a = await ask({ element: 'div', comment: text }, COMMENT_QUESTIONS);
    labels.comments[text] = { type: a.type.choice, vague: Number(a.vague.noul.toFixed(3)) };
  }
  for (const item of corpus.domChanges) {
    const a = await ask({ url: 'https://app.example/', changes: item.changes }, DOM_QUESTIONS);
    labels.domChanges[item.name] = { newState: Number(a.newState.noul.toFixed(3)) };
  }
  fs.writeFileSync(labelsPath, JSON.stringify(labels, null, 1) + '\n');
  return labels;
}

const labels = await label();
let typeSkipped = 0, typeOk = 0, vagueOk = 0, domOk = 0;
const misses = [];

for (const text of corpus.comments) {
  const j = labels.comments[text];
  const localType = Insights.suggestType(text);
  const localVague = Insights.isVague(text);
  const jevVague = j.vague >= VAGUE_THRESHOLD;
  // the type of a comment that is itself too vague to act on is not meaningful: only judge the others
  if (jevVague) typeSkipped++;
  else if (localType === j.type) typeOk++; else misses.push(`type   "${text}": local=${localType} jev=${j.type}`);
  if (localVague === jevVague) vagueOk++; else misses.push(`vague  "${text}": local=${localVague} jev=${j.vague}`);
}
for (const item of corpus.domChanges) {
  const j = labels.domChanges[item.name];
  const local = UI.isNewScreen(item.changes);
  const jev = j.newState >= 0.5;
  if (local === jev) domOk++; else misses.push(`dom    "${item.name}": local=${local} jev=${j.newState}`);
}

const n = corpus.comments.length, m = corpus.domChanges.length;
console.log(`comment type : ${typeOk}/${n - typeSkipped} (vague comments skipped)`);
console.log(`comment vague: ${vagueOk}/${n}`);
console.log(`DOM new screen: ${domOk}/${m}`);
if (misses.length) console.log('\nDisagreements with Jev:\n' + misses.map((x) => '  ' + x).join('\n'));
