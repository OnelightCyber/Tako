# Third-party notices

Tako includes or uses the following third-party material. Each keeps its own licence.

## Portions of the application code

Parts of Tako's code — among them the island window shell, the mascot animation engine, the opening and
file-drop animations, the hook relay and the Claude Code hook installer — are derived from software released
under the MIT License:

```
MIT License

Copyright (c) 2026 Louis Raillé

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Integration logos

The GitHub, Vercel, n8n, Resend, Notion, Cal.com and Stripe logo paths come from
[Simple Icons](https://simpleicons.org) (CC0 1.0). Each logo remains a trademark of its owner and is used only to
show which service an integration connects to.

## Runtime dependencies

- [Tauri](https://tauri.app) and the Rust crates and npm packages listed in `Cargo.lock` and `package-lock.json`,
  under their own licences (mostly MIT and Apache-2.0).
- [Playwright MCP](https://github.com/microsoft/playwright-mcp) (Apache-2.0) is not bundled: Tako starts it with
  `npx` when the browser agent is turned on.
- [Claude Code](https://code.claude.com) is not bundled: the chat runs the copy the user installed and signed in
  to. Claude and Claude Code are trademarks of Anthropic; Tako is not made or endorsed by Anthropic.

## Voice

- [whisper.cpp](https://github.com/ggml-org/whisper.cpp) is compiled into Tako through the
  [whisper-rs](https://codeberg.org/tazz4843/whisper-rs) crate (Unlicense). whisper.cpp and ggml are released under
  the MIT License, Copyright (c) 2023-2024 The ggml authors.
- The speech recognition model (`ggml-small-q5_1.bin`, OpenAI Whisper weights converted by the whisper.cpp
  project, MIT) is not bundled: Tako downloads it from Hugging Face when the voice assistant is turned on and checks
  its SHA-256.
- [Piper](https://github.com/rhasspy/piper) (MIT) is not bundled: Tako downloads its official Windows release when
  a natural voice is chosen and checks its SHA-256. That release includes
  [espeak-ng](https://github.com/espeak-ng/espeak-ng) (GPL-3.0) and [ONNX Runtime](https://onnxruntime.ai) (MIT),
  which Tako runs as a separate program and never links.
- Voices, downloaded on demand from [rhasspy/piper-voices](https://huggingface.co/rhasspy/piper-voices):
  - Siwis: trained on the [SIWIS French Speech Synthesis Database](https://datashare.is.ed.ac.uk/handle/10283/2353),
    CC BY 4.0.
  - Pierre and Jessica: trained on the [UPMC voice data](https://github.com/marytts/upmc-pierre-data) from the
    MaryTTS project, CC BY-SA 4.0.
