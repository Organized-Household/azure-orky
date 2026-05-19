# azure-orky
Orky is an ai orchestration api using Azure infrastructure.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `MAX_TOKENS_PER_EXECUTION` | `100000` | Per-execution Anthropic API token budget. Execution is halted before the next API call if cumulative token usage exceeds this value. Set to `0` to disable. Default of 100,000 tokens is approximately $0.30 per execution at claude-sonnet-4-5 pricing. |

