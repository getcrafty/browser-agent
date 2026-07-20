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
    <a href="#typescript"><img src="https://img.shields.io/badge/TypeScript-SDK-3178c6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript SDK"></a>
    <a href="#python"><img src="https://img.shields.io/badge/Python-SDK-3776ab?style=for-the-badge&logo=python&logoColor=white" alt="Python SDK"></a>
    <a href="./LICENSE.md"><img src="https://img.shields.io/badge/License-MIT-black?style=for-the-badge" alt="MIT License"></a>
  </p>
</div>

---

## Requirements

- Node.js and npm
- Google Chrome or a compatible Chromium installation
- An API key for the configured model provider

Supported providers include OpenAI, Anthropic, Google, Together, and vLLM-compatible endpoints.

## SDKs

Browser Agent provides TypeScript and Python SDKs for running browser automation tasks. Both SDKs start the bundled executable, stream progress events, and return a final result.

Set `OPENAI_API_KEY` or pass the API key directly when creating the agent.

### TypeScript

Requires Node.js 20 or newer.

```ts
import { BrowserAgent } from "crafty-browser-agent";

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

## License

Licensed under the [MIT License](./LICENSE.md).
