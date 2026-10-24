import { normalizePath, requestUrl, type App, type Plugin } from 'obsidian';
import {
  ASSETS, ASSET_RELEASE, ASSET_PACK_URL, DEFAULT_ASSET_BASE,
  assertAsset, decodeAssetPack,
} from './assetPack';

export const LOCAL_ASSET_BYTES = ASSETS.reduce((total, [, size]) => total + size, 0);
export interface LocalAssetProgress { completed: number; total: number; path?: string }

/** Release-isolated caches preserve old files for rollback and verify content, not just size. */
export class LocalAssetStore {
  private readonly root: string;
  private preparing: Promise<string> | null = null;

  constructor(
    private readonly app: App,
    plugin: Plugin,
    private readonly remoteBase: () => string,
  ) {
    this.root = normalizePath(`${app.vault.configDir}/plugins/${plugin.manifest.id}/assets/${ASSET_RELEASE}`);
  }

  get localBaseUrl(): string {
    const suffix = '/glb/skeleton.glb';
    const sentinel = this.app.vault.adapter.getResourcePath(normalizePath(`${this.root}${suffix}`))
      .split(/[?#]/, 1)[0];
    return sentinel.endsWith(suffix) ? sentinel.slice(0, -suffix.length) : sentinel;
  }

  async isReady(): Promise<boolean> {
    return ASSETS.length > 0 && (await this.missingAssets()).length === 0;
  }

  prepare(onProgress?: (progress: LocalAssetProgress) => void, forceCheck = false): Promise<string> {
    // Share active downloads even when callers request a fresh check.
    // Completed operations clear themselves so every new prepare verifies disk content.
    void forceCheck;
    if (!this.preparing) {
      this.preparing = this.downloadMissing(onProgress).finally(() => { this.preparing = null; });
    }
    return this.preparing;
  }

  async readJson<T>(relative: string): Promise<T> {
    const bytes = await this.app.vault.adapter.readBinary(normalizePath(`${this.root}/${relative}`));
    assertAsset(relative, bytes);
    return JSON.parse(new TextDecoder().decode(bytes)) as T;
  }

  private async validAsset(relative: string, expectedSize: number): Promise<boolean> {
    const path = normalizePath(`${this.root}/${relative}`);
    if (!(await this.app.vault.adapter.exists(path))) return false;
    const stat = await this.app.vault.adapter.stat(path);
    if (!stat || stat.size !== expectedSize) return false;
    try {
      assertAsset(relative, await this.app.vault.adapter.readBinary(path));
      return true;
    } catch { return false; }
  }

  private async downloadMissing(onProgress?: (progress: LocalAssetProgress) => void): Promise<string> {
    if (!ASSETS.length) throw new Error('Asset release metadata is not ready');
    await this.ensureFolder(normalizePath(`${this.root}/glb`));
    const base = this.remoteBase().replace(/\/+$/, '');
    if ((await this.missingAssets()).length && base === DEFAULT_ASSET_BASE) {
      try {
        await this.installAssetPack();
      } catch (error) {
        console.warn('[anatomed] Asset pack unavailable; using verified versioned file fallback', error);
      }
    }
    let completed = 0;
    onProgress?.({ completed, total: ASSETS.length });
    for (const [relative, expectedSize] of ASSETS) {
      if (!(await this.validAsset(relative, expectedSize))) {
        const response = await requestUrl({ url: `${base}/${relative}` });
        assertAsset(relative, response.arrayBuffer);
        await this.app.vault.adapter.writeBinary(normalizePath(`${this.root}/${relative}`), response.arrayBuffer);
      }
      onProgress?.({ completed: ++completed, total: ASSETS.length, path: relative });
    }
    if (!(await this.isReady())) throw new Error('Asset cache failed post-install verification');
    return this.localBaseUrl;
  }

  private async missingAssets(): Promise<string[]> {
    const missing: string[] = [];
    for (const [relative, expectedSize] of ASSETS) {
      if (!(await this.validAsset(relative, expectedSize))) missing.push(relative);
    }
    return missing;
  }

  private async installAssetPack(): Promise<void> {
    const response = await requestUrl({ url: ASSET_PACK_URL });
    const archive = decodeAssetPack(response.arrayBuffer);
    for (const [relative] of ASSETS) {
      await this.app.vault.adapter.writeBinary(
        normalizePath(`${this.root}/${relative}`), archive[relative].slice().buffer as ArrayBuffer,
      );
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    if (await this.app.vault.adapter.exists(path)) return;
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent && parent !== path) await this.ensureFolder(parent);
    await this.app.vault.adapter.mkdir(path);
  }
}
