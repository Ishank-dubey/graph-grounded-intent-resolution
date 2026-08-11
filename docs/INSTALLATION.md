# Installation and local verification

This document describes the tested local-development installation for the
sanitized research artifact. The extension is a research prototype, not a
Chrome Web Store release.

## Prerequisites

- Git
- Node.js 18 or later with npm
- Google Chrome or Microsoft Edge
- An authorized Salesforce organization for live extension use

No global Bun installation is needed. `npm ci` installs the pinned project-local
Bun executable used by the build, tests, and benchmark.

## Install and verify

```text
git clone https://github.com/Ishank-dubey/graph-grounded-intent-resolution.git
cd graph-grounded-intent-resolution
npm ci
npm run typecheck
npm run test:headless
npm run experiment:headless
npm run build
```

Expected outcomes:

- TypeScript completes without errors.
- The deterministic headless test suite passes without Salesforce credentials.
- The synthetic benchmark writes its results and exits successfully.
- `npm run build` creates the browser bundles and panel assets under `dist/`.

## Load the unpacked extension

1. Open `chrome://extensions` in Chrome or `edge://extensions` in Edge.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Select the repository directory containing `manifest.json`.
5. Pin **OmniStudio Tools** from the browser toolbar if desired.
6. Open an authenticated Salesforce page under `*.salesforce.com` or
   `*.force.com`, then click the extension icon.

After rebuilding, use the extension page's **Reload** button before testing the
new bundle.

## AI-provider configuration

The Headless tab supports Salesforce Einstein as well as optional Anthropic and
OpenAI providers. Open the Headless tab's settings control to select a provider.
Anthropic and OpenAI keys are stored in `chrome.storage.local` for this extension
profile and are sent only to the selected provider when its functionality is
used. Do not place API keys, Salesforce session identifiers, organization
exports, or `.env` files in the repository.

Using an external model sends the capability-graph prompt to that provider.
Review organizational data-handling policy before enabling this option.

## Browser permissions

The manifest requests the following permissions:

- `cookies` and `tabs` to associate an authenticated Salesforce session with
  the active Salesforce tab.
- `scripting` to inject the runtime observation hook into the page's main world.
- `sidePanel` to host the extension interface.
- `storage` for local settings and browser-session state.
- `webRequest` to observe relevant Salesforce request metadata used by the
  debugger.

Host access is limited to Salesforce domains and the optional Anthropic and
OpenAI API endpoints declared in `manifest.json`.

## Remove the extension and local settings

Open the browser's extensions page and choose **Remove** for OmniStudio Tools.
Removing the unpacked extension removes its extension-local settings from that
browser profile. The cloned repository and `node_modules` directory remain on
disk and can be deleted separately by the user.

## Troubleshooting

- If `npm ci` reports a Node engine problem, upgrade to a supported Node.js LTS
  release.
- If the toolbar icon does not appear, pin the extension from the browser's
  extension menu.
- If the side panel shows no Salesforce tab, open an authenticated Salesforce
  page and reload the extension.
- If a source change is not visible, run `npm run build` again and reload the
  unpacked extension.
- Live org behavior is outside the credential-free artifact verification scope;
  failures may also reflect Salesforce permissions, sharing, CRUD/FLS, or API
  availability.
