# Sanitized research artifact

This archive accompanies the manuscript "Graph-Grounded Intent Resolution for Enterprise Low-Code Automation: An OmniStudio Case Study."

It contains source code, deterministic fixtures, tests, and design documentation needed to inspect the prototype mechanics described in the paper. Generated bundles, source maps, organization exports, internal repository references, development-machine paths, and operating-system metadata are intentionally excluded.

## Quick start

Requirements: Node.js 18 or later, npm, Git, and Chrome or Edge.

```text
git clone https://github.com/Ishank-dubey/graph-grounded-intent-resolution.git
cd graph-grounded-intent-resolution
npm ci
npm run typecheck
npm run test:headless
npm run experiment:headless
npm run build
```

Then open `chrome://extensions` (or `edge://extensions`), enable **Developer
mode**, choose **Load unpacked**, and select the repository directory. Open an
authorized Salesforce organization and click the **OmniStudio Tools** toolbar
icon.

The repository installs a project-local Bun runtime through npm, so a global
Bun installation is not required. See [`docs/INSTALLATION.md`](docs/INSTALLATION.md)
for configuration, permissions, troubleshooting, and removal instructions.

## Verification scope

```text
bun install --frozen-lockfile
bun run typecheck
bun run test:headless
bun run experiment:headless
```

The tests and synthetic benchmark require no Salesforce credentials. Live
extension execution requires an authorized Salesforce organization and is not
part of artifact verification.

See `ARTIFACT_MANIFEST.txt` for the sanitized file inventory and SHA-256 hashes.

## Icon provenance

The extension icon is an original AI-generated design created for this
research artifact. It represents a capability graph passing through a governed
execution boundary and does not reproduce Salesforce or other vendor branding.
