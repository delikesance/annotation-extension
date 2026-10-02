	AI WEB ANNOTATOR
	================

	DESCRIPTION
	-----------
Chrome Extension (Manifest V3) to interactively annotate web pages and
export structured DOM context, screenshots, and prompts for AI.


	INSTALLATION
	------------
1. Build the extension:
     npm run build

2. In Google Chrome, go to:
     chrome://extensions/

3. Enable "Developer mode" (top right toggle).
4. Click "Load unpacked" and select the dist/ directory.


	USAGE
	-----
1. Click the extension icon on any page to freeze interactions.
2. Click any element to add a numbered badge and enter notes.
3. Click "Terminer & Exporter" in the HUD:
   - Downloads page screenshot (.png) with numbered badges.
   - Downloads structured DOM context (.json) with selectors and XPath.
   - Copies ready-to-use LLM prompt to clipboard.


	COMMANDS
	--------
npm install       Install dependencies
npm run build     Build to dist/
npm run dev       Development watch mode
npm test          Run unit tests
npm run package   Build and create release zip in dist/

docker compose up Dev watch mode in Docker
