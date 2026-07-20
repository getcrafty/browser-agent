# AGENTS.md

## Architecture

- Keep reusable `src/core/` APIs configurable through explicit typed inputs and dependency injection. Do not make core entrypoints depend on YAML files, CLI arguments, or implicit environment configuration.
- Keep CLI YAML parsing and validation centralized in `src/utils.ts` (`loadConfig`).
- Keep shared model, action, message, and provider contracts in `src/agents/types.ts`.
- Expose new public core surfaces through `src/core/index.ts` and `src/core/types.ts`.
- Route provider execution through `src/agents/providers/ai-sdk.ts`; do not add provider-specific router implementations.
- Put runtime-configurable flags in `src/config-feature-flags.ts` and internal static flags in `src/featureFlags.ts`.

## Model and DOM Contracts

- Planner, cookie, and executor model outputs must remain YAML-compatible with `chatYAML` and their typed contracts.
- Actions targeting DOM elements must use `bid` values from the current DOM snapshot.
- Simplified DOM changes must preserve assumptions used by `src/agents/extract-valid-bids.ts`, `src/browser/simplified-dom-minifier.ts`, and `src/agents/prompts.ts`.

## Authentication Safety

- Treat changes to auth runtime, executor integration, prompts, config parsing, or auth input handling as security-sensitive.
- Never expose real credentials to a model, prompt payload, screenshot, simplified DOM, history, logs, thrown errors, or serialized results.
- Match the current URL to a configured auth domain before decrypting its identifier or password. Keep domain, identifier, and password encrypted independently.
- Plaintext credentials are allowed only at direct runtime entrypoints and must be encrypted immediately. YAML configuration must accept encrypted credentials only.
- Models may inspect only redacted DOM to identify auth controls. Credential lookup, entry, and submission must remain in runtime code.
- Keep protected auth `bid` values redacted and suppress screenshots while sensitive values may be present.
- When automated auth cannot proceed safely, return it as unhandled and use manual takeover only when enabled.
- Cover auth behavior changes with unit tests and maintain or extend the local fixture/e2e coverage.

## Verification and Dependencies

- Run relevant DOM pipeline tests after simplified DOM changes.
- For planner or executor contract changes, run focused unit tests and relevant e2e coverage.
- When adding dependencies, SDKs, native modules, browser tooling, or runtime executables, update `package.json` and its lockfile in the same change.
