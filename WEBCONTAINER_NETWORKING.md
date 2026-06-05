# WebContainer networking — what can connect out, and how the corpus is affected

Research notes for interpreting the `net` / `http` / `dgram` / `dns` buckets when
running the Node corpus inside a StackBlitz WebContainer. TL;DR: in-container
loopback works for free (our probe proved it); reaching the open internet or your
host machine needs paid features; raw TCP-to-external and **all UDP** are
structurally impossible in a browser.

## The four "outbound" layers

| Layer | Works? | Gating | Mechanism |
|---|---|---|---|
| **In-container loopback** (`127.0.0.1`, the container's own ports) | ✅ Free | none | virtualized TCP stack over a Service Worker; how dev servers + our `http loopback` probe work |
| **External HTTP(S)** (`fetch` / `http.request` to the internet) | ⚠️ via **CORS proxy** | Personal+ (or project-owner-enabled) | SW detects an external host, redirects to a StackBlitz server-side proxy that re-issues the request without CORS and returns it |
| **Your host machine's `localhost`** (container → your real PC) | ⚠️ **localhost connection** | Personal+ | **this is the "upgrade to Personal+" notice** |
| **Raw TCP to external host / any UDP** | ❌ Impossible | — | no browser primitive; needs Direct Sockets (Isolated Web Apps only), which WC isn't |

The Service Worker **is** the network stack — you can't register your own SW in a
WebContainer because theirs is load-bearing.

## How does a website connect to *my* machine's localhost?

It doesn't "tunnel out of the sandbox." The trick is simpler:

1. **The browser already runs on your machine.** A process on your computer can
   always open a loopback connection to `127.0.0.1:PORT` on that same computer —
   that's ordinary, no magic. So when the WebContainer needs to reach the host's
   localhost, StackBlitz maps that container "socket" (through its Service Worker
   network layer) onto a **real browser `fetch` to `http://localhost:PORT`**.
   Because the browser is on the host, that fetch resolves to the host's loopback.

2. **What's actually restricted is *which pages may do it*.** A page served from a
   *public* origin (stackblitz.com) asking to reach a *local/loopback* address is
   a "public → local" request. Chrome gates these:
   - **Private Network Access (PNA)** → a CORS-style **preflight** the local
     server must answer.
   - **Local Network Access (LNA)** (Chrome 138+) → an explicit **user permission
     prompt**, only allowed from **secure (HTTPS) contexts**, identified by a
     private-IP/`.local` host or `fetch(..., { targetAddressSpace: "local" })`.
     Motivation: stop remote pages CSRF-ing your router / fingerprinting your LAN.
   - The localhost server must also satisfy **CORS** (or the proxy handles it).

3. **StackBlitz gates it behind Personal+** as a product decision and handles those
   CORS/PNA/secure-context wrinkles for you. So the feature = "let this remote
   project's container talk to a server you're running on your own machine," via
   the browser that's already sitting on your machine. The sandboxed JS never gets
   raw OS socket access; the *browser process* makes a permission-gated localhost
   request on the container's behalf.

## What this means for the corpus

The corpus never needs your host machine (layer 3) — Node's tests open servers and
connect to them **inside the container** (layer 1), which is free and confirmed
working. **So the Personal+ notice is irrelevant; dismiss it.** And we excluded
`test/internet` (layer 2), so external connectivity barely matters either.

Expected results by module — the pass/fail split *is* the network-coverage map:

- **`dgram` (UDP)** → ❌ wholesale fail. No UDP in a browser, period. The one hard
  structural ceiling (not a paywall).
- **`net`** → loopback ✅; failures = external connects or unsupported socket
  options/raw-socket behavior.
- **`http` / `https` / `http2`** → loopback ✅; external client requests would need
  the proxy, but `test/parallel` is almost all loopback.
- **`dns`** → external resolution limited → expect failures.
- **`tls`** → loopback may work; external + cert paths limited.
- **WebSocket to external** → CORS/handshake-limited (browser-native API otherwise).

## Sources

- StackBlitz — Avoiding CORS issues (CORS proxy + localhost-connection feature): https://blog.stackblitz.com/posts/cors-proxy/
- Chrome — Local Network Access permission prompt: https://developer.chrome.com/blog/local-network-access
- Chrome — Private Network Access update (2024): https://developer.chrome.com/blog/private-network-access-update-2024-03
- WICG — Local Network Access spec: https://wicg.github.io/local-network-access/
- webcontainer-core #1617 — host ↔ container localhost: https://github.com/stackblitz/webcontainer-core/issues/1617
- webcontainer-core #2007 — Chrome LNA + WC iframes: https://github.com/stackblitz/webcontainer-core/issues/2007
- webcontainer-core #662 — remote WebSocket failures: https://github.com/stackblitz/webcontainer-core/issues/662
- WebContainers troubleshooting: https://webcontainers.io/guides/troubleshooting
