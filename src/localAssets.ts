import { normalizePath, requestUrl, type App, type Plugin } from 'obsidian';

const ASSETS = [
  ['glb/insertions.glb', 1_383_896],
  ['glb/joints.glb', 1_140_768],
  ['glb/muscles.glb', 2_971_584],
  ['glb/nerves.glb', 5_835_352],
  ['glb/organs.glb', 1_386_016],
  ['glb/regions.glb', 752_024],
  ['glb/skeleton.glb', 1_873_564],
  ['glb/vessels.glb', 5_692_308],
  ['parts-neighbors.json', 5_960_668],
] as const;

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
    return this.app.vault.adapter.getResourcePath(this.root).replace(/\/+$/, '');
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

  private async ensureFolder(path: string): Promise<void> {
    if (!(await this.app.vault.adapter.exists(path))) {
      await this.app.vault.adapter.mkdir(path);
    }
  }
}
