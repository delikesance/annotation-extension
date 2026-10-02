import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { JSDOM } from 'jsdom';

const require = createRequire(import.meta.url);
const SelectorGenerator = require('../src/content/selector-generator.js');

test('SelectorGenerator - generates unique selector for element with ID', () => {
  const dom = new JSDOM(`
    <!DOCTYPE html>
    <html>
      <body>
        <div id="app">
          <button id="cta-button" class="btn primary">Click me</button>
        </div>
      </body>
    </html>
  `);

  const button = dom.window.document.getElementById('cta-button');
  const selector = SelectorGenerator.getUniqueSelector(button);

  assert.equal(selector, '#cta-button');
  const matched = dom.window.document.querySelectorAll(selector);
  assert.equal(matched.length, 1);
  assert.equal(matched[0], button);
});

test('SelectorGenerator - generates unique selector with data-testid attribute', () => {
  const dom = new JSDOM(`
    <!DOCTYPE html>
    <html>
      <body>
        <div>
          <button data-testid="submit-form-btn">Submit</button>
        </div>
      </body>
    </html>
  `);

  const button = dom.window.document.querySelector('[data-testid="submit-form-btn"]');
  const selector = SelectorGenerator.getUniqueSelector(button);

  assert.equal(selector, 'button[data-testid="submit-form-btn"]');
  const matched = dom.window.document.querySelectorAll(selector);
  assert.equal(matched.length, 1);
  assert.equal(matched[0], button);
});

test('SelectorGenerator - generates unique hierarchical selector for list items without IDs', () => {
  const dom = new JSDOM(`
    <!DOCTYPE html>
    <html>
      <body>
        <main>
          <ul class="nav-links">
            <li class="item">Home</li>
            <li class="item">About</li>
            <li class="item">Contact</li>
          </ul>
        </main>
      </body>
    </html>
  `);

  const secondItem = dom.window.document.querySelectorAll('li.item')[1];
  const selector = SelectorGenerator.getUniqueSelector(secondItem);

  assert.ok(selector, 'Selector should not be empty');
  const matched = dom.window.document.querySelectorAll(selector);
  assert.equal(matched.length, 1, `Selector "${selector}" must uniquely match exactly 1 element`);
  assert.equal(matched[0], secondItem);
});

test('SelectorGenerator - generates correct XPath', () => {
  const dom = new JSDOM(`
    <!DOCTYPE html>
    <html>
      <body>
        <div id="container">
          <main>
            <p>Paragraph 1</p>
            <p>Paragraph 2</p>
          </main>
        </div>
      </body>
    </html>
  `);

  const p2 = dom.window.document.querySelectorAll('p')[1];
  const xpath = SelectorGenerator.getXPath(p2);

  assert.equal(xpath, '/html/body/div[1]/main[1]/p[2]');
});

test('SelectorGenerator - extracts complete metadata structure', () => {
  const dom = new JSDOM(`
    <!DOCTYPE html>
    <html>
      <body>
        <input type="email" name="user_email" class="input-field active" placeholder="Enter your email" value="test@example.com" />
      </body>
    </html>
  `);

  const input = dom.window.document.querySelector('input');
  const meta = SelectorGenerator.getElementMetadata(input, 1, 'Fix email validation message');

  assert.equal(meta.index, 1);
  assert.equal(meta.comment, 'Fix email validation message');
  assert.equal(meta.element.tag, 'INPUT');
  assert.deepEqual(meta.element.classes, ['input-field', 'active']);
  assert.equal(meta.element.attributes.type, 'email');
  assert.equal(meta.element.attributes.name, 'user_email');
  assert.equal(meta.element.attributes.placeholder, 'Enter your email');
  assert.ok(meta.element.cssSelector.length > 0);
  assert.ok(meta.element.xpath.length > 0);
});
