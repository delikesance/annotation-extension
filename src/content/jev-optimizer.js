/**
 * JEV Optimizer & Decision Engine (TypeSafe System One)
 *
 * Provides:
 * 1. Rapid System One decisions: Intent classification (Choice), Actionability (Noul), Priority (Score).
 * 2. Token Economy: Prunes 60-80% of unnecessary CSS/DOM noise based on intent, saving tokens for target AI agents.
 * 3. Offline / deterministic fallback when API key is unavailable.
 */

class JevOptimizer {
  constructor(apiKey = null) {
    this.apiKey = apiKey;
    this.apiEndpoint = 'https://api.typesafe.ai/v1/systemone';
    this.model = 'jev-latest';
  }

  async getApiKey() {
    if (this.apiKey) return this.apiKey;
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
      try {
        const stored = await chrome.storage.local.get(['TYPESAFE_API_KEY']);
        if (stored && stored.TYPESAFE_API_KEY) {
          return stored.TYPESAFE_API_KEY;
        }
      } catch (_) {}
    }
    if (typeof process !== 'undefined' && process.env && process.env.TYPESAFE_API_KEY) {
      return process.env.TYPESAFE_API_KEY;
    }
    return null;
  }

  /**
   * Evaluates an annotation using Jev System One if apiKey is available,
   * or falls back to fast local heuristics.
   */
  async optimizeAnnotation(annotation) {
    const apiKey = await this.getApiKey();
    const comment = (annotation.comment || '').trim();
    const meta = annotation.metadata ? (annotation.metadata.element || {}) : (annotation.element || {});

    let analysis = null;

    if (apiKey && comment.length > 0) {
      try {
        analysis = await this.callJev(comment, meta);
      } catch (err) {
        console.warn('[Jev Optimizer] Jev API call failed, using deterministic fallback:', err);
        analysis = this.localFallbackAnalysis(comment, meta);
      }
    } else {
      analysis = this.localFallbackAnalysis(comment, meta);
    }

    const prunedStyles = this.pruneStyles(meta.computedStyles || {}, analysis.intent);
    const rawTokensEstimate = this.estimateTokens({ comment, meta });
    const prunedTokensEstimate = this.estimateTokens({
      comment,
      intent: analysis.intent,
      prunedStyles,
      tag: meta.tag,
      cssSelector: meta.cssSelector,
      xpath: meta.xpath,
      text: meta.text
    });

    const tokenSavingsPercent = rawTokensEstimate > 0
      ? Math.max(0, Math.round(((rawTokensEstimate - prunedTokensEstimate) / rawTokensEstimate) * 100))
      : 0;

    return {
      index: annotation.index,
      comment,
      intent: analysis.intent,
      intentLabel: this.getIntentLabel(analysis.intent),
      isActionable: analysis.isActionable,
      actionabilityScore: analysis.actionabilityScore,
      priority: analysis.priority,
      priorityLabel: analysis.priorityLabel,
      prunedStyles,
      parentContext: this.pruneParent(meta.parent, analysis.intent),
      tokenSavings: {
        rawEstimate: rawTokensEstimate,
        prunedEstimate: prunedTokensEstimate,
        savedPercent: tokenSavingsPercent
      }
    };
  }

  async callJev(comment, meta) {
    const state = {
      user_comment: comment,
      element_tag: meta.tag || 'unknown',
      element_text: (meta.text || '').substring(0, 100),
      css_selector: meta.cssSelector || ''
    };

    const payload = {
      model: this.model,
      state: JSON.stringify(state),
      questions: {
        intent: {
          type: 'choice',
          instructions: 'What kind of web development task is requested in this annotation comment?',
          criteria: {
            layout_css: 'Layout, responsiveness, alignment, flexbox/grid, margins, padding, overlap or positioning issue',
            styling_visual: 'Visual styling: colors, fonts, borders, shadows, opacity, icons, theme',
            behavior_js: 'Interactive behavior: click action, javascript logic, state management, form submit, modal open',
            content_copy: 'Content, copy, typography typo, text wording, missing textual information',
            accessibility_a11y: 'Accessibility, screen readers, contrast ratio, aria labels, keyboard focus'
          }
        },
        is_actionable: {
          type: 'noul',
          instructions: 'Does this comment provide a specific, actionable instruction that a coding agent can fix without guessing?'
        },
        priority: {
          type: 'score',
          instructions: 'Priority level for this task',
          criteria: [
            'Low: minor cosmetic tweak or suggestion',
            'Medium: normal UI fix or content modification',
            'High: broken layout, blocking bug or critical functional defect'
          ]
        }
      }
    };

    const apiKey = await this.getApiKey();
    const res = await fetch(this.apiEndpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`TypeSafe API error ${res.status}: ${errText}`);
    }

    const data = await res.json();
    const answers = data.answers || {};

    const intent = (answers.intent && answers.intent.choice) || 'layout_css';
    const isActionable = (answers.is_actionable && answers.is_actionable.noul >= 0.5) || true;
    const actionabilityScore = answers.is_actionable ? answers.is_actionable.noul : 0.8;
    const scoreVal = (answers.priority && typeof answers.priority.score === 'number') ? answers.priority.score : 1;

    let priority = 'P2';
    let priorityLabel = 'Moyenne (P2)';
    if (scoreVal >= 1.5) {
      priority = 'P1';
      priorityLabel = 'Élevée / Bloquant (P1)';
    } else if (scoreVal <= 0.5) {
      priority = 'P3';
      priorityLabel = 'Basse / Cosmétique (P3)';
    }

    return {
      intent,
      isActionable,
      actionabilityScore,
      priority,
      priorityLabel
    };
  }

  localFallbackAnalysis(comment, meta) {
    const c = (comment || '').toLowerCase();
    let intent = 'layout_css';

    if (/\b(couleur|color|police|font|border|bordure|arrondi|radius|shadow|ombre|fond|background|thème|theme|sombre|dark)\b/i.test(c)) {
      intent = 'styling_visual';
    } else if (/\b(texte|faute|typo|titre|titling|orthographe|mot|phrase|phrase|libellé|label|traduire|traduction|copy)\b/i.test(c)) {
      intent = 'content_copy';
    } else if (/\b(clic|click|action|ouvrir|fermer|soumettre|submit|bug|erreur|error|bloque|marche pas|fonctionne pas|javascript|api|state)\b/i.test(c)) {
      intent = 'behavior_js';
    } else if (/\b(contraste|aria|a11y|accessibilité|accessibility|lecteur d'écran|tabindex|focus)\b/i.test(c)) {
      intent = 'accessibility_a11y';
    } else if (/\b(déborde|overflow|aligner|align|centrer|center|marge|margin|padding|espace|gap|responsive|mobile|desktop|flex|grid|position|largeur|hauteur|width|height)\b/i.test(c)) {
      intent = 'layout_css';
    }

    const wordCount = c.split(/\s+/).filter(Boolean).length;
    const isActionable = wordCount >= 3;
    const actionabilityScore = isActionable ? 0.85 : 0.4;

    let priority = 'P2';
    let priorityLabel = 'Moyenne (P2)';
    if (/\b(urgent|bloquant|critique|crash|casse|cassé|impossible|asap|p1)\b/i.test(c)) {
      priority = 'P1';
      priorityLabel = 'Élevée / Bloquant (P1)';
    } else if (/\b(peut-être|suggestion|éventuellement|optionnel|détail|mineur|p3)\b/i.test(c)) {
      priority = 'P3';
      priorityLabel = 'Basse / Cosmétique (P3)';
    }

    return { intent, isActionable, actionabilityScore, priority, priorityLabel };
  }

  getIntentLabel(intent) {
    switch (intent) {
      case 'layout_css': return '📐 Layout & Responsive (CSS)';
      case 'styling_visual': return '🎨 Design & Style Visuel';
      case 'behavior_js': return '⚡ Comportement & JS';
      case 'content_copy': return '📝 Contenu & Typo';
      case 'accessibility_a11y': return '♿ Accessibilité (A11y)';
      default: return '🔧 Modification Générale';
    }
  }

  /**
   * Prunes computed styles dictionary based on intent to minimize token footprint.
   */
  pruneStyles(styles, intent) {
    if (!styles || typeof styles !== 'object') return {};

    const layoutKeys = ['display', 'position', 'flexDirection', 'alignItems', 'justifyContent', 'gap', 'gridTemplateColumns', 'width', 'height', 'margin', 'padding', 'boxSizing', 'overflow', 'zIndex', 'top', 'left', 'right', 'bottom'];
    const styleKeys = ['color', 'backgroundColor', 'fontSize', 'fontWeight', 'borderRadius', 'border', 'boxShadow', 'opacity', 'lineHeight'];
    const a11yKeys = ['color', 'backgroundColor', 'fontSize', 'display', 'visibility', 'outline'];

    let allowed = [];
    if (intent === 'layout_css') {
      allowed = [...layoutKeys, 'visibility'];
    } else if (intent === 'styling_visual') {
      allowed = [...styleKeys, 'display'];
    } else if (intent === 'accessibility_a11y') {
      allowed = a11yKeys;
    } else if (intent === 'content_copy') {
      allowed = ['fontSize', 'fontWeight', 'color'];
    } else {
      allowed = [...layoutKeys.slice(0, 8), ...styleKeys.slice(0, 4)];
    }

    const pruned = {};
    for (const k of allowed) {
      if (styles[k] && styles[k] !== 'none' && styles[k] !== 'auto' && styles[k] !== 'normal') {
        pruned[k] = styles[k];
      }
    }
    return pruned;
  }

  pruneParent(parent, intent) {
    if (!parent) return null;
    if (intent === 'content_copy') return null; // No parent needed for copy fixes
    return {
      tag: parent.tag,
      classes: parent.classes,
      display: parent.display || parent.computedStyles?.display,
      dimensions: parent.dimensions
    };
  }

  estimateTokens(obj) {
    const str = JSON.stringify(obj || '');
    return Math.ceil(str.length / 4);
  }
}

if (typeof window !== 'undefined') {
  window.JevOptimizer = JevOptimizer;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = JevOptimizer;
}
