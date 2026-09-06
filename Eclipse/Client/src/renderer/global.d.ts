/// <reference types="vite/client" />

import type { PulseBridge } from "../shared/ipc";

declare global {
  interface Window {
    pulse: PulseBridge;
  }
}

export {};
