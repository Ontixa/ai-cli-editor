import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import type { UpdateInfo } from "./types";

/**
 * Thin wrapper over the Tauri updater plugin. The only intentional network
 * call in the app: it queries the configured GitHub Releases endpoint for a
 * signed `latest.json`. All failures bubble up to the caller, which swallows
 * them — offline or no releases simply means "no update".
 */

let pending: Update | null = null;

/** Returns info about a newer release, or null when up to date. */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  const update = await check();
  if (!update) {
    pending = null;
    return null;
  }
  pending = update;
  return {
    version: update.version,
    date: update.date ?? undefined,
    notes: update.body ?? undefined,
  };
}

/** Downloads + installs the last checked update; reports byte progress. */
export async function downloadAndInstall(
  onProgress: (downloaded: number, total: number | undefined) => void,
): Promise<void> {
  const update = pending;
  if (!update) throw new Error("checkForUpdate() must succeed first");
  let downloaded = 0;
  let total: number | undefined;
  await update.downloadAndInstall((ev) => {
    if (ev.event === "Started") {
      total = ev.data.contentLength;
      onProgress(0, total);
    } else if (ev.event === "Progress") {
      downloaded += ev.data.chunkLength;
      onProgress(downloaded, total);
    } else if (ev.event === "Finished") {
      onProgress(total ?? downloaded, total);
    }
  });
  pending = null;
}

/** Restart into the freshly installed version (no-op if install exits first). */
export async function relaunchApp(): Promise<void> {
  await relaunch();
}
