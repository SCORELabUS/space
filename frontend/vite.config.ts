import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths';
import { resolve } from 'node:path';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ''); 
  const rootEnv = loadEnv(mode, resolve(process.cwd(), '..'), 'SPHERE_PUBLIC_URL');
  
  const basePath = env.BASE_PATH || "/";
  const finalBase = basePath.startsWith('/') ? basePath : `/${basePath}`;
  const safeBase = finalBase.endsWith('/') ? finalBase : `${finalBase}/`;

  return {
    // Expose only this public URL, never the rest of the server environment.
    define: {
      'import.meta.env.SPHERE_PUBLIC_URL': JSON.stringify(env.SPHERE_PUBLIC_URL ?? rootEnv.SPHERE_PUBLIC_URL ?? ''),
    },
    base: safeBase,
    server: {
      port: Number(env.VITE_PORT || 5174),
    },
    plugins: [
      react(),
      tailwindcss(),
      tsconfigPaths()
    ],
  }
})
