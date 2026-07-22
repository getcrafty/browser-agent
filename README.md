<div align="center">
  <a href="https://getcrafty.io">
    <picture>
      <img src="./assets/crafty-mark.svg" width="72" alt="Crafty">
    </picture>
  </a>

  <h1>Crafty Browser Agent</h1>

  <p>
    A web automation agent that uses LLMs to inspect and interact with dynamic web pages, extract data, complete long horizon tasks, and verify outcomes with a validator.
  </p>

  <p>
    <a href="https://getcrafty.io"><img src="https://img.shields.io/badge/Crafty-getcrafty.io-ffbf00?style=for-the-badge" alt="Crafty website"></a>
    <a href="https://www.npmjs.com/package/@getcrafty/browser-agent"><img src="https://img.shields.io/badge/TypeScript-SDK-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript SDK"></a>
    <a href="https://pypi.org/project/browser-agent-python-sdk/"><img src="https://img.shields.io/badge/Python-SDK-3776ab?style=for-the-badge&logo=python&logoColor=white" alt="Python SDK"></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/License-MIT-black?style=for-the-badge" alt="MIT License"></a>
  </p>
</div>

---

## Requirements

- Node.js and npm
- Google Chrome or a compatible Chromium installation
- An API key for the configured model provider

Supported providers include OpenAI, OpenRouter, Anthropic, Google, Together, and vLLM-compatible endpoints.

To pin an OpenRouter model to one inference provider without fallbacks, set
`openrouter_provider` in the YAML configuration:

```yaml
provider: openrouter
model: z-ai/glm-5.2
reasoning_effort: xhigh
openrouter_provider: baseten/fp8
```

`openrouter_provider` is valid only with `provider: openrouter`. It maps to an
OpenRouter `only` constraint with provider fallbacks disabled. Exact endpoint
IDs containing a precision suffix, such as `baseten/fp8`, are passed through
unchanged.

## SDKs

Browser Agent provides TypeScript and Python SDKs for running browser automation tasks. Both SDKs install the matching CLI from the GitHub Release, verify its checksum, stream progress events, and return a final result.

Set the selected provider's API-key environment variable, such as `OPENAI_API_KEY` or `OPENROUTER_API_KEY`, or pass the API key directly when creating the agent.

### TypeScript

Requires Node.js 20 or newer.

```sh
npm install @getcrafty/browser-agent
```

```ts
import { BrowserAgent } from "@getcrafty/browser-agent";

const agent = new BrowserAgent({
	provider: "openai",
	model: "gpt-5.4",
	downloadDirectory: "./downloads",
});

const run = agent.run({
	task: "Find the first five articles on the OpenAI blog.",
	url: "https://openai.com/news/",
});

for await (const event of run.events()) {
	console.log(event);
}

const result = await run.result;
```

See the [TypeScript SDK documentation](./sdk/typescript-sdk/README.md).

### Python

Requires Python 3.11 or newer.

```sh
pip install browser-agent-python-sdk
```

```python
import asyncio

from browser_agent import BrowserAgent, BrowserAgentTask


async def main():
    agent = BrowserAgent(
        provider="openai",
        model="gpt-5.4",
        download_directory="./downloads",
    )

    run = agent.run(
        BrowserAgentTask(
            "Find the first five articles on the OpenAI blog.",
            "https://openai.com/news/",
        )
    )

    async for event in run.events():
        print(event)

    result = await run.result


asyncio.run(main())
```

See the [Python SDK documentation](./sdk/python-sdk/README.md).

## Credentials

Tasks may include website credentials. They are sent only through the local child-process stream, encrypted immediately, and excluded from configuration files, logs, and errors.

## Checklist and retry verifier

Semantic checklist generation and retry verification are enabled by default. The verifier receives the full validator history and browser-state context, may reject a candidate up to three times, and returns its feedback to the executor so the task can continue. Equivalent explicit settings are:

```yaml
feature_flags:
  task_checklist: true

validator_lifecycle:
  mode: retry
  max_failures: 3
  context: full
```

If `stage_llms.createChecklist` is omitted, it inherits `stage_llms.createPlan`. Checklist generation runs in parallel with plan generation. Set `feature_flags.task_checklist: false` to disable it. Set `validator_lifecycle.mode: terminal` to restore one-shot terminal validation; `context: compact` remains available for ablations.

## License

Licensed under the [MIT License](./LICENSE.md).
