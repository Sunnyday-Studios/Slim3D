import { defineConfig } from 'vite';
import glsl from 'vite-plugin-glsl';

// host:true so you can open it from a phone on the same Wi-Fi (device-reach testing).
// allowedHosts:true lets a cloudflared/ngrok HTTPS tunnel reach the dev server —
// needed because WebGPU only works in a secure context (https/localhost), so a phone
// must hit an https tunnel, not the plain-http LAN IP.
export default defineConfig({
  plugins: [glsl()],
  server: { host: true, open: false, allowedHosts: true },
});
