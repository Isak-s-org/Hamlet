import { defineConfig } from "vite";
import { API_PREFIX, loadOrCreateConfig, TOKEN_HEADER } from "@hamlet/shared";

const { port, token } = loadOrCreateConfig();

// The proxy adds the daemon token so it never reaches the browser.
export default defineConfig({
  server: {
    proxy: { [API_PREFIX]: { target: `http://127.0.0.1:${port}`, headers: { [TOKEN_HEADER]: token } } },
  },
});
