# SLogicWeb

A browser logic analyzer and mixed-signal viewer for Sipeed SLogic16 U3 and SLogic32 U3:
digital channels, the SLogic32 U3's ADC module as analog rows, and sigrok protocol
decoders on one timeline. It talks to the board over WebUSB, so there is nothing to
install: open the page in a Chromium-based browser, connect the board and capture.
Everything runs locally; there are no accounts and no cloud.

- Hosted: https://slogic.sipeed.com
- Source: https://github.com/sipeed/slogicweb

## Features

- Single, Repeat and Loop capture with digital and qualified analog triggers, pre-trigger
  and a conservative, link-aware default rate.
- Analog rows from the ADC module with a declared gain, V/div, autoset and a graticule
  that follows the row height.
- 130+ sigrok decoders (Pyodide), a searchable results list and CSV/TXT export.
- Open `.sr` and `.lwcap`; save `.lwcap`, `.sr`, `.vcd` and `.csv`.
- Installable offline app (service worker), plus a single-file portable build.
- English, 简体中文, Français and Русский.

## Development

```bash
npm install
npm run dev          # http://127.0.0.1:5173/
npm run dev:lan      # HTTPS on the LAN (WebUSB needs a secure context); run `npm run cert` first
npm test             # type-check and every offline self-test
npm run build        # production build into dist/
npm run dist && npm run check:portable   # single-file portable build and its smoke test
```

The product and engineering contracts are in `docs/ARCHITECTURE.md` and `docs/DESIGN.md`;
deployment notes are in `docs/DEPLOY.md`.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for third-party
components, including the sigrok decoders.

Copyright (C) 2026 Sipeed Co., Ltd. and contributors.

## Acknowledgements

SLogicWeb grew out of [logicweb](https://github.com/tralamazza/logicweb), the browser logic
analyzer for the SLogic16 U3 written by Daniel Tralamazza. Thank you for the original
design and code.

Protocol decoding uses [sigrok](https://sigrok.org/) decoders, and the device protocol was
cross-checked against the sipeed-slogic-analyzer driver in libsigrok.
