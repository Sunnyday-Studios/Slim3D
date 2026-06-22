# Slim3D

An interactive slime blob you poke and stretch, running in-browser with zero install.
Core simulation kernel: **MLS-MPM on WebGPU**. See [kernel-eval.md](kernel-eval.md) for why
this kernel was chosen.

## Run it

```bash
npm install
npm run dev
```

Open the printed URL (default **http://localhost:5173**) in a WebGPU browser:
Chrome/Edge (desktop), Android Chrome 121+, or Safari 26+ (iOS/macOS). `host: true` is set,
so the LAN URL it prints also works from a phone on the same Wi-Fi.

If you see a black canvas, tick **"Show particles"** — point-sprite particles use a simpler
render path and isolate whether the issue is the sim or the screen-space surface shader.

## Roadmap

- **M0 — done:** known-good MLS-MPM blob renders (upstream Newtonian material). Confirms toolchain + WebGPU.
- **M1 — viscoelastic material:** add a per-particle deformation gradient `F` + Neo-Hookean/
  corotated elastic stress with a plastic return mapping → real slime (stretch, sag, snap-back).
  This is the core slime physics; lives in `mls-mpm/p2g_2.wgsl` + `g2p.wgsl`.
- **M2 — pointer poke/drag:** project pointer to the blob, inject force on nearby particles.
- **M3 — slime look:** restyle the screen-space surface (`render/fluid.wgsl`) — color, Fresnel, translucency.
- **M4 — WebGL2 fallback:** graceful degradation for the ~18% without WebGPU (see kernel-eval.md §5).

## Credits / license

Slim3D is a fork of **[matsuoka-601/WebGPU-Ocean](https://github.com/matsuoka-601/WebGPU-Ocean)**
(MIT). The original copyright notice is preserved in [LICENSE.upstream](LICENSE.upstream).
Slim3D's own additions are MIT-licensed.
