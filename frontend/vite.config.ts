import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import tsconfigPaths from 'vite-tsconfig-paths';

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ''); 
  
  const basePath = env.BASE_PATH || "/";
  const finalBase = basePath.startsWith('/') ? basePath : `/${basePath}`;
  const safeBase = finalBase.endsWith('/') ? finalBase : `${finalBase}/`;

  return {
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
