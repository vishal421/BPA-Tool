# BPA Proxy — Local Server + Console

Runs the full Palo Alto Networks BPA generation flow (token → upload config →
poll result) through a small Node.js server on your own machine. This solves
the browser CORS problem: your browser only ever talks to `localhost`, and
Node.js makes the real calls to Palo Alto server-to-server, exactly like `curl`.

## Requirements

- Node.js 18 or later (for built-in `fetch`)
  Check with: `node -v`
  If missing:
  ```
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
  ```

## Setup (one time)

1. Copy this whole `bpa-proxy` folder onto your Ubuntu machine.
2. Open a terminal in that folder and install dependencies:
   ```
   npm install
   ```

## Run

```
npm start
```

You should see:
```
BPA Proxy running → http://localhost:3000
```

Open that URL in a browser **on the same machine** (or replace `localhost`
with the server's LAN IP if opening from another device on your network,
e.g. `http://192.168.1.50:3000`).

## Using the console

1. **Stage 1 — Authenticate**: enter your Client ID, Client Secret, and TSG ID.
   Click **Generate Token**.
2. **Stage 2 — Upload configuration file**: choose your device type, drag in
   the exported config `.xml`, click **Initiate & Upload**. The server gzips
   the file and pushes it to the presigned upload URL for you.
3. **Stage 3 — Generate BPA result**: click **Check Status**. If the status
   comes back `IN_PROGRESS`, just click it again after 30–60 seconds. Once it
   shows `COMPLETED`, the full JSON appears in the console pane and you can
   click **Download JSON** to save it.

## Notes / troubleshooting

- **Firewall**: this machine needs outbound HTTPS access to
  `auth.apps.paloaltonetworks.com` and `api.sase.paloaltonetworks.com`.
  If requests hang or fail immediately, check `sudo ufw status` and your
  organization's egress firewall rules.
- **Port already in use**: run on a different port with
  `PORT=4000 npm start`, then open `http://localhost:4000`.
- **Run in the background / keep alive after closing terminal**:
  ```
  nohup npm start > bpa-proxy.log 2>&1 &
  ```
  or, better, use `pm2`:
  ```
  sudo npm install -g pm2
  pm2 start server.js --name bpa-proxy
  ```
- **Field names differ**: the server looks for `upload_url`/`uploadUrl`/`url`
  and `id`/`report_id`/`reportId` in Palo Alto's response. If Stage 2 says
  "Unexpected response", open the browser dev tools Network tab, look at the
  `/api/initiate-upload` response, and tell me the actual field names —
  I'll adjust `server.js` accordingly.
- **Security**: this is intended for local/internal use. It does not persist
  credentials anywhere — everything lives only in browser memory for the
  current tab session. If exposing beyond localhost, put it behind your own
  authentication (e.g. an nginx reverse proxy with basic auth) since anyone
  who can reach the page can use it to call the API with whatever
  credentials are typed in.
