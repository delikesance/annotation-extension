import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const JevOptimizer = require('../src/content/jev-optimizer.js');

test('JevOptimizer - correctly categorizes intent and prunes layout CSS to save tokens', async () => {
  const optimizer = new JevOptimizer();

  const annotation = {
    index: 1,
    comment: 'Le bouton déborde sur mobile et dépasse de sa rangée flex',
    metadata: {
      element: {
        tag: 'BUTTON',
        text: 'Envoyer ma demande',
        cssSelector: '#submit-btn',
        xpath: '/html/body/main/section/button',
        computedStyles: {
          display: 'flex',
          position: 'relative',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '8px',
          width: '320px',
          height: '48px',
          margin: '10px 0px 10px 0px',
          padding: '12px 24px 12px 24px',
          boxSizing: 'border-box',
          overflow: 'hidden',
          zIndex: '10',
          color: 'rgb(255, 255, 255)',
          backgroundColor: 'rgb(79, 70, 229)',
          fontSize: '16px',
          fontWeight: '700',
          borderRadius: '8px',
          border: '1px solid rgb(99, 102, 241)',
          boxShadow: 'none',
          opacity: '',
          visibility: 'visible'
        },
        parent: {
          tag: 'form',
          classes: ['contact-form-row'],
          display: 'flex',
          dimensions: '600x400'
        }
      }
    }
  };

  const result = await optimizer.optimizeAnnotation(annotation);

  assert.equal(result.index, 1);
  assert.equal(result.intent, 'layout_css');
  assert.match(result.intentLabel, /Layout/);
  assert.equal(result.isActionable, true);

  // Check pruning
  assert.ok(result.prunedStyles.display, 'Layout properties should be retained');
  assert.ok(result.prunedStyles.flexDirection, 'flexDirection should be retained');
  assert.ok(result.prunedStyles.width, 'width should be retained');
  assert.equal(result.prunedStyles.borderRadius, undefined, 'Visual styling should be pruned for layout bugs');

  // Verify token savings
  assert.ok(result.tokenSavings.savedPercent >= 30, `Tokens saved percent should be significant, got ${result.tokenSavings.savedPercent}%`);
});

test('JevOptimizer - correctly categorizes copywriting/typo intent and eliminates all layout CSS noise', async () => {
  const optimizer = new JevOptimizer();

  const annotation = {
    index: 2,
    comment: 'Faute de frappe dans le titre principal: remplacer "Abonemnt" par "Abonnement"',
    metadata: {
      element: {
        tag: 'H1',
        text: 'Votre Abonemnt Mensuel',
        cssSelector: 'h1.title',
        xpath: '/html/body/h1',
        computedStyles: {
          display: 'block',
          width: '500px',
          height: '40px',
          margin: '20px 0 10px 0',
          padding: '0',
          color: 'rgb(15, 23, 42)',
          fontSize: '32px',
          fontWeight: '800'
        }
      }
    }
  };

  const result = await optimizer.optimizeAnnotation(annotation);

  assert.equal(result.intent, 'content_copy');
  assert.match(result.intentLabel, /Contenu/);
  assert.equal(result.prunedStyles.width, undefined, 'Layout dimensions should be pruned for copy changes');
  assert.equal(result.parentContext, null, 'Parent context pruned for copy changes');
});

test('JevOptimizer - live Jev System One evaluation with valid API key', async () => {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) {
    console.log('Skipping live Jev test (no API key in test environment)');
    return;
  }

  const optimizer = new JevOptimizer(apiKey);
  const annotation = {
    index: 1,
    comment: 'The checkout button fails to submit when clicked and causes a console TypeError',
    element: {
      tag: 'BUTTON',
      text: 'Complete Order',
      cssSelector: '#btn-checkout',
      computedStyles: {
        display: 'inline-block',
        width: '200px'
      }
    }
  };

  const result = await optimizer.optimizeAnnotation(annotation);
  assert.equal(result.index, 1);
  assert.ok(result.intent === 'behavior_js' || result.intent === 'layout_css');
  assert.equal(result.isActionable, true);
  assert.ok(result.priority === 'P1' || result.priority === 'P2');
});
