# ApplyPilot

ApplyPilot is a local job-application assistant made of a Node.js server and a Chrome extension. It searches Lever, Greenhouse, and Ashby postings, prepares tailored application documents, and fills supported application forms. Questions it cannot safely answer are handed to you.

## Requirements

- Node.js 20 or newer
- Google Chrome or Chromium
- An Anthropic API key for AI answers and tailored documents
- A Serper or Brave Search API key for job search

The server has no npm dependencies.

## Run the server

Set these variables in the terminal environment before starting the server:

- `ANTHROPIC_API_KEY`
- `APPLYPILOT_SEARCH_KEY`

Then, from this directory, run:

```sh
node server/server.js
```

Open [http://localhost:8787](http://localhost:8787) and complete your profile and job-search preferences.

## Install and connect the extension

1. In Chrome, open `chrome://extensions` and enable **Developer mode**.
2. Select **Load unpacked** and choose this project's `extension/` folder.
3. Open ApplyPilot's **Settings** page and copy the connection token.
4. Open the ApplyPilot extension, paste the token, and select **Connect**.
5. Start the server, queue jobs from the dashboard, then select **Start** in the extension.

Keep the server and ApplyPilot's Chrome window open while it runs. Review your profile and generated answers; the extension can submit applications. Captchas, verification codes, and questions needing your judgment are handed to you.

## Local data and API keys

Your profile, applications, and generated PDFs are kept under `data/` on your computer. That directory is excluded from Git and is not included in this repository. API keys are read from the environment; do not commit them or add them to source files.

## Tests

Run the Node.js tests with:

```sh
node --test test/*.test.js
```

The browser end-to-end test is `test/e2e.py`; it requires Python, Playwright, Chromium (or Chrome), and OpenSSL.
