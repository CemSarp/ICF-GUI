import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import pkg from './package.json';

// The app freezes Object.prototype (tauri.conf freezePrototype), so `enum.toString = fn` throws in strict
// mode. xterm and addon-webgl each have one such assignment in their key-code tables; define the property instead.
const xtermFrozenProto = {
  name: 'xterm-frozen-prototype',
  transform(code: string, id: string) {
    if (!/@xterm[\\/](xterm|addon-webgl)[\\/]lib[\\/]\w[\w-]*\.mjs$/.test(id)) return null;
    const out = code.replace(
      /\b(\w+)\.toString=(\w+);/g,
      'Object.defineProperty($1,"toString",{value:$2,writable:true,configurable:true});',
    );
    if (out === code) throw new Error('xterm-frozen-prototype: pattern not found in ' + id + ', xterm changed');
    return out;
  },
};

export default defineConfig({
  plugins: [react(), xtermFrozenProto],
  clearScreen: false,
  // The sidebar shows this, so the label cannot drift from the released version.
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  // `fs.allow`: the Handbook screen imports ../docs/HANDBOOK.md (the dev server serves only allowed folders).
  server: { port: 1420, strictPort: true, host: 'localhost', fs: { allow: ['.', '../docs'] } },
  build: { target: 'safari16', sourcemap: false },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.ts'],
    include: ['tests/**/*.test.{ts,tsx}'],
  },
});
