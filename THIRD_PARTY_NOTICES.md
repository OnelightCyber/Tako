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
