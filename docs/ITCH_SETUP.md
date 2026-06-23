# Publishing Slim3D to itch.io (with auto-updates via butler)

butler is itch.io's CLI uploader. Every push to itch creates a new build; the
itch.io web player serves it immediately and the itch desktop app delta-patches
installed copies. This repo's GitHub Action does it automatically on every push to
`main`.

## One-time setup (you do these — they need your account)

1. **itch.io account.** Create/sign in at https://itch.io.

2. **Create the game page.** Dashboard → **Create new project**:
   - **Kind of project:** HTML
   - **Title:** Slim3D · **URL slug:** `slim3d` (so it's `https://<you>.itch.io/slim3d`)
   - Check **"This file will be played in the browser"** (set after the first build uploads).
   - **Embed:** "Embed in page", a generous viewport (e.g. 1280×720), enable **fullscreen**.
   - Save as **Draft** (publish when ready).

3. **API key.** https://itch.io/user/settings/api-keys → **Generate new key**.

4. **Wire CI** (auto-update on every push to `main`): in the GitHub repo
   (`Sunnyday-Studios/Slim3D`) → **Settings → Secrets and variables → Actions**:
   - **New repository secret:** `BUTLER_API_KEY` = the key from step 3
   - **New repository variable:** `ITCH_USER` = your itch.io username

That's it — the next push to `main` builds and publishes. Watch it under the repo's
**Actions** tab.

## First publish (or any manual push)

Either trigger the GitHub Action (Actions → "Deploy to itch.io" → Run workflow), or
push from your machine:

```bash
ITCH_USER=<your-itch-username> \
BUTLER_API_KEY=<key> \
BUTLER="C:/Users/ngson/butler/butler.exe" \
npm run deploy:itch
```

(butler is already installed at `C:/Users/ngson/butler/butler.exe`. `butler login`
also works instead of passing the key each time.)

## ⚠️ Verify after the first publish: WebGPU in the itch iframe

Slim3D needs **WebGPU**. itch runs HTML5 games in a sandboxed iframe — WebGPU should
work (it's a secure HTTPS context and isn't gated by permissions-policy), but this is
the **first thing to test** on the live itch page. If it shows "WebGPU not available"
there, the **WebGL2 fallback (roadmap M4)** is the fix. The asset paths are already
relative (`base: './'` in `vite.config.ts`), which is required for the itch iframe.
