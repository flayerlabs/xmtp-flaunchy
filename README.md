# XMTP Flaunchy Chat Bot

This is an XMTP chat bot that responds as Flaunchy using OpenAI's GPT-4.

## Setup

1. Generate your XMTP keys:

```bash
yarn gen:keys
```

2. Create a `.env` file with the following variables:

```bash
WALLET_KEY=     # From gen:keys output
ENCRYPTION_KEY= # From gen:keys output
OPENAI_API_KEY= # Your OpenAI API key
XMTP_ENV=dev    # local, dev, or production
```

3. Install dependencies:

```bash
yarn install
```

4. Start the bot:

```bash
yarn start
```

## Features

- Responds to messages in character as Flaunchy
- Maintains consistent character personality using dynamic context
- Handles both direct messages and group chats
- Graceful error handling with in-character error messages

## Development

To run in development mode with hot reloading:

```bash
yarn dev
```

## License

MIT
