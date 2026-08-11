# Sanitized research artifact

This archive accompanies the manuscript "Graph-Grounded Intent Resolution for Enterprise Low-Code Automation: An OmniStudio Case Study."

It contains source code, deterministic fixtures, tests, and design documentation needed to inspect the prototype mechanics described in the paper. Generated bundles, source maps, organization exports, internal repository references, development-machine paths, and operating-system metadata are intentionally excluded.

## Requirements

- Bun 1.3 or later
- Node.js 18 or later
- A Chromium-compatible browser for extension loading

## Verification

```text
bun install --frozen-lockfile
bun run typecheck
bun run test:headless
bun run experiment:headless
```

The tests and synthetic benchmark require no Salesforce credentials. Live extension execution requires an authorized Salesforce organization and is not part of artifact verification.

See `ARTIFACT_MANIFEST.txt` for the sanitized file inventory and SHA-256 hashes.

## Icon provenance

The extension icon is an original AI-generated design created for this
research artifact. It represents a capability graph passing through a governed
execution boundary and does not reproduce Salesforce or other vendor branding.
