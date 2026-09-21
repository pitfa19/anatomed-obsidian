import { normalizePath, requestUrl, type App, type Plugin } from 'obsidian';
import { ASSETS, ASSET_PACK_URL, decodeAssetPack } from './assetPack';

export const LOCAL_ASSET_BYTES = ASSETS.reduce((total, [, size]) => total + size, 0);

export interface LocalAssetProgress {
  completed: number;
  total: number;
  path?: string;
}

/**
 * Keeps the large anatomy files in the vault's plugin directory. Community
 * Plugins only installs main.js, manifest.json, and styles.css, so these files
 * are fetched once, verified by byte length, then served from disk thereafter.
 */
export class LocalAssetStore {
  private readonly root: string;
  private preparing: Promise<string> | null = null;

  constructor(
    private readonly app: App,
    plugin: Plugin,
    private readonly remoteBase: () => string,
  ) {
    this.root = normalizePath(`${app.vault.configDir}/plugins/${plugin.manifest.id}/assets`);
  }

  get localBaseUrl(): string {
    // getResourcePath() is file-oriented and may append a cache-busting query.
    // Calling it for the directory and then appending `/glb/...` can therefore
    // produce an invalid URL such as `assets?mtime/glb/skeleton.glb`. Resolve a
    // real sentinel file, remove its query, then trim the known relative suffix.
    const suffix = '/glb/skeleton.glb';
    const sentinel = this.app.vault.adapter
      .getResourcePath(normalizePath(`${this.root}${suffix}`))
      .split(/[?#]/, 1)[0];
    return sentinel.endsWith(suffix) ? sentinel.slice(0, -suffix.length) : sentinel;
  }

  async isReady(): Promise<boolean> {
    for (const [relative, expectedSize] of ASSETS) {
      const path = normalizePath(`${this.root}/${relative}`);
      if (!(await this.app.vault.adapter.exists(path))) return false;
      const stat = await this.app.vault.adapter.stat(path);
      if (!stat || stat.size !== expectedSize) return false;
    }
    return true;
  }

  prepare(
    onProgress?: (progress: LocalAssetProgress) => void,
    forceCheck = false,
  ): Promise<string> {
    if (forceCheck) this.preparing = null;
    if (!this.preparing) {
      this.preparing = this.downloadMissing(onProgress).catch((error) => {
        this.preparing = null;
        throw error;
      });
    }
    return this.preparing;
  }

  async readJson<T>(relative: string): Promise<T> {
    const path = normalizePath(`${this.root}/${relative}`);
    return JSON.parse(await this.app.vault.adapter.read(path)) as T;
  }

  private async downloadMissing(
    onProgress?: (progress: LocalAssetProgress) => void,
  ): Promise<string> {
    await this.ensureFolder(this.root);
    await this.ensureFolder(normalizePath(`${this.root}/glb`));

    const missing = await this.missingAssets();
    if (missing.length > 0) {
      try {
        await this.installAssetPack();
      } catch (error) {
        console.warn('[anatomed] GitHub asset pack unavailable; using legacy file fallback', error);
      }
    }

    let completed = 0;
    onProgress?.({ completed, total: ASSETS.length });
    for (const [relative, expectedSize] of ASSETS) {
      const path = normalizePath(`${this.root}/${relative}`);
      const stat = (await this.app.vault.adapter.exists(path))
        ? await this.app.vault.adapter.stat(path)
        : null;
      if (!stat || stat.size !== expectedSize) {
        const url = `${this.remoteBase().replace(/\/+$/, '')}/${relative}`;
        const response = await requestUrl({ url });
        if (response.arrayBuffer.byteLength !== expectedSize) {
          throw new Error(
            `asset size mismatch for ${relative}: expected ${expectedSize}, received ${response.arrayBuffer.byteLength}`,
          );
        }
        await this.app.vault.adapter.writeBinary(path, response.arrayBuffer);
      }
      completed += 1;
      onProgress?.({ completed, total: ASSETS.length, path: relative });
    }

    return this.localBaseUrl;
  }

  private async missingAssets(): Promise<string[]> {
    const missing: string[] = [];
    for (const [relative, expectedSize] of ASSETS) {
      const path = normalizePath(`${this.root}/${relative}`);
      const stat = (await this.app.vault.adapter.exists(path))
        ? await this.app.vault.adapter.stat(path)
        : null;
      if (!stat || stat.size !== expectedSize) missing.push(relative);
    }
    return missing;
  }

  private async installAssetPack(): Promise<void> {
    const response = await requestUrl({ url: ASSET_PACK_URL });
    const archive = decodeAssetPack(response.arrayBuffer);
    for (const [relative] of ASSETS) {
      await this.app.vault.adapter.writeBinary(
        normalizePath(`${this.root}/${relative}`),
        archive[relative].slice().buffer as ArrayBuffer,
      );
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(path))) {
      await this.app.vault.adapter.mkdir(path);
    }
  }
}
