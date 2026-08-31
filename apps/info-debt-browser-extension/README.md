# Tomohisa Information Debt Browser Extension

Chromium/Edge Manifest V3 extension for saving the active page to the local
Information Debt HTTP API. Version 0.1 captures only the page URL, title, and a
required user-written `why_saved` note.

## Run the local API

From the repository root, configure the existing Information Debt MySQL
environment variables, then run:

```powershell
npm run info-debt-api
```

The default address is `http://127.0.0.1:43127`. Set
`PI_INFO_DEBT_HTTP_PORT` before starting the API and update the extension's
options page when a different port is needed.

## Install in Chrome or Edge

1. Open `chrome://extensions` or `edge://extensions`.
2. Enable Developer mode.
3. Select **Load unpacked**.
4. Choose this directory: `apps/info-debt-browser-extension`.

Open an HTTP/HTTPS page, click the extension, enter why the page is worth
saving, and select **保存**.

## API contract

```http
POST /v1/debts
Content-Type: application/json

{
  "url": "https://example.com/article",
  "title": "Example article",
  "why_saved": "Relevant to the current research project"
}
```

The API maps browser captures to `sourceType=web`, `debtType=discovery`,
`status=inbox`, and `priority=3`. It does not fetch or parse page content.
