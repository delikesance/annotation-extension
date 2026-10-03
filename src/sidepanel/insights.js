/**
 * Local, deterministic heuristics behind the comment editor's suggestions
 * (type of an annotation, "too vague" nudge). Their quality is measured against
 * Jev judgments at development time: see scripts/eval-heuristics.mjs.
 */
(function (root) {
  const AnnotationInsights = {
    suggestType(comment) {
      const c = (comment || '').toLowerCase();
      // an explicit request to rewrite wording wins, even if the words "erreur" or "titre" appear in it
      if (/(reformul|traduc|faute|coquille|orthograph|wording|libell[ée] )/.test(c)) return 'text';
      if (/(\bbug\b|erreur|cass[ée]|d[ée]sactiv|reste blanc|reste vide|ne s['’]ouvre|ne se (met|ferme|charge|ouvre|lance)|\bne\s+(\w+\s+){0,2}pas\b|ne (fonctionne|marche|r[ée]agit|r[ée]pond)|impossible|plante|bloqu|\b(404|500)\b|crash|inactif|ne s['’]affiche)/.test(c)) return 'bug';
      // a measure, a color or a layout word means a visual change, even when "texte" or "titre" is mentioned
      if (/(\d\s?(px|rem|em|%)|#[0-9a-f]{3,6}\b|couleur|contraste|espacement|marge|hauteur|largeur|bordure|arrondi|align|police|taille|gras|ic[ôo]ne|colonne|grille|trop (petit|grand|gros))/.test(c)) return 'style';
      if (/(texte|phrase|[«“"].+[»”"])/.test(c)) return 'text';
      return 'style';
    },
    isVague(comment) {
      const c = (comment || '').trim().toLowerCase();
      if (!c) return false;
      const words = c.split(/\s+/).length;
      const hasSpecifics = /\d|px|rem|%|#[0-9a-f]{3,6}|[«"“].+[»"”]|\b(en|de|à|vers|par)\s+\w+/.test(c);
      const vagueWord = /(trop|bizarre|moche|pas bien|pas coh[ée]rent|à revoir|a revoir|retravailler|améliorer|ameliorer|mieux|joli|propre|bof|aime pas)/.test(c);
      return words <= 3 || (vagueWord && !hasSpecifics);
    }
  };
  root.AnnotationInsights = AnnotationInsights;
  if (typeof module !== 'undefined' && module.exports) module.exports = AnnotationInsights;
})(typeof window !== 'undefined' ? window : globalThis);
