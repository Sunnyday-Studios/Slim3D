import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

// base:'./' -> RELATIVE asset paths. Required for itch.io (HTML5 games run in an
// iframe served from a subpath, so absolute '/assets/..' 404s there). Also works
// on Cloudflare Pages and any static host, so it's set globally.
// host:true exposes the dev server on the LAN; allowedHosts:true lets a cloudflared
// HTTPS tunnel reach it (WebGPU needs a secure context, so phones hit the tunnel).
export default defineConfig({
  base: './',
  plugins: [glsl()],
  server: { host: true, open: false, allowedHosts: true },
});
