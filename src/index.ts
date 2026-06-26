import { runServer } from "./server.js";

// Only run the server if this file is the main module
const isMainModule = process.argv[1] === new URL(import.meta.url).pathname;
if (isMainModule) {
  runServer();
}
