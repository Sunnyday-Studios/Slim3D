# Publishing Slim3D to itch.io (with auto-updates via butler)

butler is itch.io's CLI uploader. Every push to itch creates a new build; the
itch.io web player serves it immediately and the itch desktop app delta-patches
installed copies. This repo's GitHub Action does it automatically on every push to
`main`.

## Status: configured ✅ (2026-06-23)

- **Target game:** `sunnydaytech.itch.io/slime-and-stuff`, channel `html5`.
- **First build pushed** via butler (build `#1745328`).
- **Auto-update CI wired:** repo secret `BUTLER_API_KEY` + variable
  `ITCH_USER=sunnydaytech` are set, so every push to `main` auto-builds and publishes
  via `.github/workflows/deploy-itch.yml`. Watch runs under the repo **Actions** tab.

### Remaining (one-time, on the itch dashboard — butler can't toggle page settings)

On the slime-and-stuff **Edit game** page:
- Mark the `html5` build **"This file will be played in the browser."**
- **Embed:** set a viewport (e.g. 1280×720) and enable **fullscreen**.
- Set the page **Public** when ready to launch.

### Rotating the API key

Generate a new key at https://itch.io/user/settings/api-keys, then re-set the secret:
`gh secret set BUTLER_API_KEY --repo Sunnyday-Studios/Slim3D` (paste the new key).

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
