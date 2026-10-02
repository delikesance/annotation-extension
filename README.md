# AI Web Annotator 🎯

> Extension Chrome (Manifest V3) pour développeurs, testeurs et prompt engineers permettant d'annoter interactivement n'importe quelle page web et d'exporter un contexte DOM structuré et visuel pour vos IA (ChatGPT, Claude, Gemini, etc.).

---

## 🌟 Fonctionnalités

1. **Activation instantanée & Freeze** :
   - Un clic sur l'icône de l'extension active le mode annotation et **fige la page web** (blocage des clics intempestifs, de la navigation sur les liens et des formulaires).
2. **Survol & Détection visuelle (Hover)** :
   - Mise en surbrillance dynamique de l'élément HTML sous le curseur avec indication de la balise et des classes CSS.
3. **Badges numérotés & Saisie interactive** :
   - Clic sur un élément pour positionner un badge numéroté (`1`, `2`, `3`...).
   - Ouverture d'une fenêtre de saisie pour saisir votre commentaire / instruction pour l'IA.
   - Possibilité de modifier ou supprimer un point à tout moment.
4. **Export double & Contexte IA** :
   - **Capture d'écran (PNG)** haute fidélité montrant fidèlement la page avec les badges numérotés positionnés sur les éléments cibles.
   - **Fichier JSON structuré** contenant pour chaque point :
     - Numéro de l'annotation et commentaire.
     - Sélecteur CSS unique et robuste.
     - XPath absolu.
     - Balise, identifiant, classes et attributs clés (`name`, `type`, `role`, etc.).
     - Dimensions et coordonnées de l'élément (`rect` et `pageRect`).
     - Extrait du texte visible dans l'élément.
   - **Prompt Markdown copié dans le presse-papier** prêt à être collé directement dans votre outil d'IA.
5. **Isolation totale par Shadow DOM** :
   - L'interface utilisateur de l'extension (HUD, badges, popups) est encapsulée dans un Shadow DOM afin d'éviter tout conflit avec les feuilles de style de la page inspectée.

---

## 🚀 Installation en Mode Développeur sur Google Chrome

1. **Générer le dossier `dist/`** :
   ```bash
   npm run build
   # ou via Docker :
   docker compose run --rm app npm run build
   ```
2. **Ouvrir Google Chrome** et accéder à l'URL suivante :
   ```text
   chrome://extensions/
   ```
3. Activer l'option **"Mode développeur"** (interrupteur en haut à droite).
4. Cliquer sur le bouton **"Charger l'extension non empaquetée"** (en haut à gauche).
5. Sélectionner le dossier `dist/` du projet (situé dans `/home/workstation/Projects/annotation-extension/dist`).
6. L'extension **"AI Web Annotator"** apparaît dans la liste de vos extensions !
7. *(Recommandé)* Cliquez sur l'icône puzzle dans la barre d'outils Chrome pour **épingler** l'icône de l'extension.

---

## 🛠️ Développement avec Docker

Le projet inclut une configuration Docker complète pour garantir un environnement de dev isolé et reproductible.

### 1. Construire l'image Docker
```bash
docker compose build
```

### 2. Lancer le mode développement (Watch mode)
```bash
docker compose up
```
Toute modification apportée aux fichiers dans `src/` recompilera automatiquement le dossier `dist/`.

### 3. Lancer les tests unitaires
```bash
docker compose run --rm app npm test
```

### 4. Produire l'archive `.zip` installable
```bash
docker compose run --rm app npm run package
```
Le fichier d'archive sera généré dans `dist/ai-web-annotator-v1.0.0.zip`.

---

## 💻 Développement local (Node.js)

Si vous disposez de Node.js (version 20+) installé sur votre machine :

```bash
# Installation des dépendances
npm install

# Lancer la compilation en mode surveillance
npm run dev

# Exécuter les tests unitaires
npm test

# Compiler l'extension pour production
npm run build

# Empaqueter sous forme de fichier zip
npm run package
```

---

## 📖 Guide d'Utilisation

1. **Activer le mode annotation** :
   - Rendez-vous sur n'importe quel site web ou application locale (ex: `http://localhost:3000`).
   - Cliquez sur l'icône de l'extension dans la barre d'outils Chrome.
   - La barre HUD apparaît en haut à droite avec le statut `Page Figée`.
2. **Poser une annotation** :
   - Survolez l'élément à annoter : un cadre en pointillés indigo suit le curseur.
   - Cliquez sur l'élément :
     - Le badge numéroté (ex: `1`) apparaît.
     - Une popup s'ouvre pour saisir votre instruction.
     - Tapez votre commentaire et appuyez sur **Entrée** (ou cliquez sur **Valider**).
   - Répétez l'opération sur tous les éléments souhaités (`2`, `3`, `4`...).
3. **Exporter le contexte pour l'IA** :
   - Cliquez sur le bouton **"Terminer & Exporter"** dans la barre HUD.
   - L'extension :
     1. Télécharge automatiquement `annotation-[site]-[date].png` (capture avec les badges).
     2. Télécharge automatiquement `annotation-context-[site]-[date].json` (données complètes).
     3. Copie un prompt Markdown récapitulatif dans votre presse-papier.
   - Vous pouvez coller le JSON ou le texte dans votre LLM préféré en joignant la capture d'écran !

---

## 📊 Exemple de Format de Sortie JSON

```json
{
  "meta": {
    "generator": "AI Web Annotator (Manifest V3)",
    "version": "1.0.0",
    "pageUrl": "https://example.com/checkout",
    "pageTitle": "Checkout Page",
    "timestamp": "2026-10-02T15:00:00.000Z",
    "viewport": {
      "width": 1920,
      "height": 1080,
      "devicePixelRatio": 1,
      "scrollX": 0,
      "scrollY": 100
    },
    "totalAnnotations": 1
  },
  "annotations": [
    {
      "index": 1,
      "comment": "Remplacer ce bouton par une dropdown avec les options A, B et C.",
      "element": {
        "tag": "BUTTON",
        "id": "confirm-btn",
        "classes": ["btn", "btn-primary"],
        "cssSelector": "#confirm-btn",
        "xpath": "/html/body/div[1]/main[1]/button[1]",
        "text": "Valider la commande",
        "attributes": {
          "type": "submit",
          "data-testid": "checkout-submit-btn"
        },
        "rect": {
          "x": 420,
          "y": 680,
          "width": 200,
          "height": 45
        }
      }
    }
  ]
}
```

---

## 🔄 Pipeline CI/CD (Forgejo Actions)

Le workflow est configuré dans `.forgejo/workflows/build-and-release.yaml` :
- Déclenché à chaque `push` sur la branche `main` et à chaque tag (`v*`).
- Étapes automatisées :
  1. Extraction du code source via `actions/checkout@v4`.
  2. Configuration de l'environnement Node.js 22.
  3. Installation des dépendances et exécution des tests unitaires.
  4. Compilation de l'extension dans `dist/`.
  5. Empaquetage de l'archive `.zip` prête à l'emploi.
  6. Sauvegarde et mise à disposition de l'archive dans les artefacts de build Forgejo.

---

## 📁 Structure du Projet

```text
annotation-extension/
├── .dockerignore
├── .gitignore
├── Dockerfile                   # Environnement Docker Node.js Alpine
├── compose.yaml                 # Docker Compose pour dev et packaging
├── package.json                 # Dépendances et scripts npm
├── README.md                    # Documentation complète
├── .forgejo/
│   └── workflows/
│       └── build-and-release.yaml  # Pipeline CI/CD Forgejo Actions
├── scripts/
│   ├── build.mjs                # Script de compilation vers dist/
│   └── package.mjs              # Script d'empaquetage de l'archive .zip
├── src/
│   ├── manifest.json            # Manifest V3 de l'extension
│   ├── background/
│   │   └── service-worker.js    # Service worker (capture d'écran, téléchargements)
│   ├── content/
│   │   ├── content-script.js    # Point d'entrée du script de contenu
│   │   ├── dom-freeze.js        # Gestionnaire de gel des interactions de la page
│   │   ├── selector-generator.js # Générateur de sélecteurs CSS uniques et XPaths
│   │   ├── ui-manager.js        # Interface Shadow DOM (HUD, badges, modals)
│   │   └── styles.css           # Styles isolés
│   └── icons/                   # Icônes de l'extension (16px, 48px, 128px, SVG)
└── test/
    └── selector-generator.test.mjs # Tests unitaires automatisés
```
