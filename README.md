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
- **XMTP Status Monitor**: Automatically monitors the XMTP status page and restarts the bot when issues are detected or resolved

## Development

To run in development mode with hot reloading:

```bash
yarn dev
```

## XMTP Status Monitor

The bot includes an automatic status monitoring system that watches the XMTP status page (https://status.xmtp.org/feed.rss) and automatically restarts the bot when:

- New unresolved issues are detected that affect the Node SDK or Production network
- Previously reported issues are resolved (to ensure the bot runs with latest fixes)

### Features:

- **Automatic Monitoring**: Checks status every 5 minutes
- **Smart Filtering**: Only triggers on issues affecting Node SDK or Production network
- **Restart Logic**: Gracefully restarts the process when issues are detected/resolved
- **Persistent Tracking**: Remembers startup time to avoid false positives
- **Logging**: Detailed logs of all status checks and decisions

### Testing the Status Monitor:

```bash
yarn test:status
```

This will run a 30-second test of the status monitor, showing:

- Manual status check results
- Monitor configuration
- Live monitoring demonstration

### Configuration:

The status monitor is automatically enabled when the bot starts. It stores its state in:

- `{VOLUME_PATH}/xmtp-status-monitor.json` - Tracks startup time and status
- Monitors RSS feed at: `https://status.xmtp.org/feed.rss`
- Check interval: 5 minutes (configurable in `XMTPStatusMonitor.ts`)

## License

MIT
