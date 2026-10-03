import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Insights = require('../src/sidepanel/insights.js');
const AnnotatorUIManager = require('../src/content/ui-manager.js');

const load = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const VAGUE_THRESHOLD = 0.85; // keep in sync with scripts/eval-heuristics.mjs

/**
 * The local heuristics are measured against Jev judgments recorded by `npm run eval:heuristics`
 * (Jev is a development-time judge, not part of the extension). The snapshots make this check offline.
 */
for (const [name, corpusFile, labelsFile] of [['tuning corpus', 'heuristics-corpus', 'jev-labels'], ['held-out corpus', 'heldout-corpus', 'heldout-labels']]) {
  const corpus = load(corpusFile);
  const labels = load(labelsFile);

  test(`heuristics agree with Jev judgments (${name}): comment vagueness`, () => {
    const hits = corpus.comments.filter(c => Insights.isVague(c) === (labels.comments[c].vague >= VAGUE_THRESHOLD)).length;
    assert.ok(hits / corpus.comments.length >= 0.9, `${hits}/${corpus.comments.length}`);
  });

  test(`heuristics agree with Jev judgments (${name}): comment type on actionable comments`, () => {
    const actionable = corpus.comments.filter(c => labels.comments[c].vague < VAGUE_THRESHOLD);
    const hits = actionable.filter(c => Insights.suggestType(c) === labels.comments[c].type).length;
    assert.ok(hits / actionable.length >= 0.9, `${hits}/${actionable.length}`);
  });

  test(`heuristics agree with Jev judgments (${name}): new screen vs ambient DOM noise`, () => {
    const hits = corpus.domChanges.filter(d => AnnotatorUIManager.isNewScreen(d.changes) === (labels.domChanges[d.name].newState >= 0.5)).length;
    assert.ok(hits / corpus.domChanges.length >= 0.85, `${hits}/${corpus.domChanges.length}`);
  });
}
