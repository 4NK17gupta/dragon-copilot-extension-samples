import type { ExtensionManifest } from '../schemas/manifest.schema.js';

/**
 * In-memory session store for the sandbox.
 * Stores the currently loaded manifest for use across API endpoints.
 */
class SessionStore {
  private manifest: ExtensionManifest | null = null;

  setManifest(manifest: ExtensionManifest): void {
    this.manifest = manifest;
  }

  getManifest(): ExtensionManifest | null {
    return this.manifest;
  }

  clear(): void {
    this.manifest = null;
  }
}

export const sessionStore = new SessionStore();
