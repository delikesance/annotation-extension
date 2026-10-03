/**
 * DOM Selector & Metadata Extraction Engine
 * Provides deterministic, unique CSS selectors, XPaths, computed layout/styling CSS,
 * parent container context, and rich DOM metadata for AI coding context.
 */

function escapeCss(ident) {
  if (typeof CSS !== 'undefined' && CSS.escape) {
    return CSS.escape(ident);
  }
  return ident.replace(/([!"#$%&'()*+,.\/:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

/**
 * Computes a unique, minimal CSS selector for a given DOM element.
 */
function getUniqueSelector(element) {
  if (!element || element.nodeType !== 1) return '';

  const doc = element.ownerDocument || document;

  // 1. Direct ID check
  if (element.id && typeof element.id === 'string' && element.id.trim() !== '') {
    const escapedId = '#' + escapeCss(element.id.trim());
    try {
      if (doc.querySelectorAll(escapedId).length === 1) {
        return escapedId;
      }
    } catch (_) {}
  }

  // 2. Semantic data attributes (data-testid, data-cy, name, aria-label)
  const candidateAttrs = ['data-testid', 'data-cy', 'data-test', 'name', 'aria-label', 'role'];
  for (const attr of candidateAttrs) {
    const val = element.getAttribute(attr);
    if (val) {
      const selector = `${element.tagName.toLowerCase()}[${attr}="${escapeCss(val)}"]`;
      try {
        if (doc.querySelectorAll(selector).length === 1) {
          return selector;
        }
      } catch (_) {}
    }
  }

  // 3. Hierarchical path calculation
  const path = [];
  let current = element;

  while (current && current.nodeType === 1 && current.tagName.toLowerCase() !== 'html') {
    let selector = current.tagName.toLowerCase();

    if (current.id && typeof current.id === 'string' && current.id.trim() !== '') {
      const idSel = '#' + escapeCss(current.id.trim());
      try {
        if (doc.querySelectorAll(idSel).length === 1) {
          path.unshift(idSel);
          break; // Stop at unique ID
        }
      } catch (_) {}
    }

    // Try with classes
    let classSelector = '';
    if (current.classList && current.classList.length > 0) {
      const validClasses = Array.from(current.classList)
        .filter(c => !c.includes(':') && !c.includes('/') && !c.includes('[') && !c.startsWith('ai-annotator-'))
        .slice(0, 3);
      if (validClasses.length > 0) {
        classSelector = '.' + validClasses.map(escapeCss).join('.');
      }
    }

    // Calculate nth-of-type index among siblings of same tag
    let index = 1;
    let sibling = current.previousElementSibling;
    let hasSiblingsWithSameTag = false;

    while (sibling) {
      if (sibling.tagName === current.tagName) {
        index++;
        hasSiblingsWithSameTag = true;
      }
      sibling = sibling.previousElementSibling;
    }

    if (!hasSiblingsWithSameTag) {
      let next = current.nextElementSibling;
      while (next) {
        if (next.tagName === current.tagName) {
          hasSiblingsWithSameTag = true;
          break;
        }
        next = next.nextElementSibling;
      }
    }

    if (hasSiblingsWithSameTag) {
      selector += `:nth-of-type(${index})`;
    } else if (classSelector) {
      selector += classSelector;
    }

    path.unshift(selector);

    // Check if current partial path is already globally unique
    const candidate = path.join(' > ');
    try {
      if (doc.querySelectorAll(candidate).length === 1) {
        return candidate;
      }
    } catch (_) {}

    current = current.parentElement;
  }

  return path.join(' > ');
}

/**
 * Computes the absolute XPath for a given element.
 */
function getXPath(element) {
  if (!element || element.nodeType !== 1) return '';
  if (element.tagName.toLowerCase() === 'html') return '/html';
  if (element.tagName.toLowerCase() === 'body') return '/html/body';

  let index = 1;
  let sibling = element.previousElementSibling;
  while (sibling) {
    if (sibling.tagName === element.tagName) {
      index++;
    }
    sibling = sibling.previousElementSibling;
  }

  const tagName = element.tagName.toLowerCase();
  const parentXPath = element.parentElement ? getXPath(element.parentElement) : '';
  return `${parentXPath}/${tagName}[${index}]`;
}

/**
 * Extracts key computed CSS styles for an element.
 */
function extractComputedStyles(element, win) {
  if (!element || !win || !win.getComputedStyle) return {};

  try {
    const cs = win.getComputedStyle(element);
    if (!cs) return {};

    return {
      display: cs.display || '',
      position: cs.position || '',
      flexDirection: cs.flexDirection || '',
      alignItems: cs.alignItems || '',
      justifyContent: cs.justifyContent || '',
      gap: cs.gap || '',
      gridTemplateColumns: cs.gridTemplateColumns || '',
      width: cs.width || '',
      height: cs.height || '',
      margin: `${cs.marginTop || '0'} ${cs.marginRight || '0'} ${cs.marginBottom || '0'} ${cs.marginLeft || '0'}`.trim(),
      padding: `${cs.paddingTop || '0'} ${cs.paddingRight || '0'} ${cs.paddingBottom || '0'} ${cs.paddingLeft || '0'}`.trim(),
      boxSizing: cs.boxSizing || '',
      overflow: cs.overflow || '',
      zIndex: cs.zIndex !== 'auto' ? cs.zIndex : '',
      color: cs.color || '',
      backgroundColor: cs.backgroundColor || '',
      fontSize: cs.fontSize || '',
      fontWeight: cs.fontWeight || '',
      lineHeight: cs.lineHeight || '',
      borderRadius: cs.borderRadius || '',
      border: cs.border || '',
      boxShadow: cs.boxShadow !== 'none' ? cs.boxShadow : '',
      opacity: cs.opacity !== '1' ? cs.opacity : '',
      visibility: cs.visibility || ''
    };
  } catch (_) {
    return {};
  }
}

/**
 * Extracts parent container metadata.
 */
function extractParentContext(element, win) {
  if (!element || !element.parentElement) return null;
  const parent = element.parentElement;
  if (parent.tagName.toLowerCase() === 'html') return null;

  let parentDisplay = '';
  if (win && win.getComputedStyle) {
    try {
      parentDisplay = win.getComputedStyle(parent).display || '';
    } catch (_) {}
  }

  const pRect = parent.getBoundingClientRect ? parent.getBoundingClientRect() : { width: 0, height: 0 };

  return {
    tag: parent.tagName.toLowerCase(),
    id: parent.id || null,
    classes: Array.from(parent.classList || []),
    display: parentDisplay,
    dimensions: `${Math.round(pRect.width)}x${Math.round(pRect.height)}`
  };
}

/**
 * Extracts comprehensive DOM metadata for an annotated element.
 */
function getElementMetadata(element, index, comment) {
  if (!element) return null;

  const win = element.ownerDocument ? element.ownerDocument.defaultView || window : window;
  const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : {
    x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0
  };

  const scrollX = win.scrollX || win.pageXOffset || 0;
  const scrollY = win.scrollY || win.pageYOffset || 0;

  // Extract raw text content (clean and truncated)
  let rawText = (element.innerText || element.textContent || '').trim().replace(/\s+/g, ' ');
  let textPreview = rawText;
  let textTruncated = false;
  if (rawText.length > 250) {
    textPreview = rawText.slice(0, 250) + '...';
    textTruncated = true;
  }

  // Extract key attributes
  const attributes = {};
  const interestingAttrs = [
    'id', 'name', 'type', 'placeholder', 'aria-label', 'aria-describedby',
    'role', 'href', 'src', 'alt', 'title', 'value', 'data-testid', 'data-cy', 'disabled'
  ];

  if (element.getAttribute) {
    for (const attr of interestingAttrs) {
      const val = element.getAttribute(attr);
      if (val !== null && val !== '') {
        attributes[attr] = val;
      }
    }
  }

  // Build tag hierarchy breadcrumb
  const breadcrumb = [];
  let cur = element;
  while (cur && cur.nodeType === 1 && breadcrumb.length < 5) {
    breadcrumb.unshift(cur.tagName.toLowerCase());
    cur = cur.parentElement;
  }

  const computedStyles = extractComputedStyles(element, win);
  const parentContext = extractParentContext(element, win);

  return {
    index: index,
    comment: comment || '',
    element: {
      tag: element.tagName,
      id: element.id || null,
      classes: Array.from(element.classList || []),
      cssSelector: getUniqueSelector(element),
      xpath: getXPath(element),
      breadcrumb: breadcrumb.join(' > '),
      text: textPreview,
      textTruncated: textTruncated,
      attributes: attributes,
      computedStyles: computedStyles,
      parent: parentContext,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        bottom: Math.round(rect.bottom),
        right: Math.round(rect.right)
      },
      pageRect: {
        top: Math.round(rect.top + scrollY),
        left: Math.round(rect.left + scrollX),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    }
  };
}

// Module export for Node.js test environment and Browser window object
const SelectorGenerator = {
  escapeCss,
  getUniqueSelector,
  getXPath,
  extractComputedStyles,
  extractParentContext,
  getElementMetadata
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = SelectorGenerator;
}
if (typeof window !== 'undefined') {
  window.SelectorGenerator = SelectorGenerator;
}
