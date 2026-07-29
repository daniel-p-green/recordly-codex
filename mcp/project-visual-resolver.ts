import { join } from "node:path";

import type { ProjectMediaAsset, RecordingProject } from "../src/project/index.js";
import {
  createPrivateVisualRasterAdapter,
  type RegisteredVisualMedia,
} from "../src/media/private-visual-raster.js";
import type { ResolvedVisualSource } from "../src/render/project-renderer.js";
import { ProjectMediaStore, type ImportedProjectVisualMedia } from "./project-media-store.js";

function expectedMedia(media: ImportedProjectVisualMedia): RegisteredVisualMedia {
  if (media.mediaKind === "video") {
    if (media.fps === undefined)
      throw new RangeError("registered video media is missing its frame rate");
    return {
      mediaKind: "video",
      extension: media.extension,
      width: media.width,
      height: media.height,
      fps: media.fps,
      durationSeconds: media.durationUs / 1_000_000,
    };
  }
  return {
    mediaKind: "image",
    extension: media.extension,
    width: media.width,
    height: media.height,
  };
}

function assertProjectMedia(
  projectMedia: ProjectMediaAsset,
  stored: ImportedProjectVisualMedia,
): void {
  if (
    projectMedia.id !== stored.mediaId ||
    projectMedia.sha256 !== stored.sha256 ||
    projectMedia.kind !== stored.mediaKind ||
    projectMedia.durationUs !== stored.durationUs
  ) {
    throw new RangeError("registered visual media does not match the project declaration");
  }
  if (
    projectMedia.kind === "video" &&
    (projectMedia.width !== stored.width ||
      projectMedia.height !== stored.height ||
      projectMedia.fps !== stored.fps)
  ) {
    throw new RangeError("registered video media does not match the project declaration");
  }
}

async function disposeAll(sources: readonly ResolvedVisualSource[]): Promise<void> {
  const results = await Promise.allSettled(sources.map(async (source) => source.dispose()));
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "private visual media disposal failed");
  }
}

/** Resolves one decoder handle per unique V2 visual media ID from private storage only. */
export async function resolveProjectVisualSources(input: {
  artifactRoot: string;
  ownerToken: string;
  project: RecordingProject;
}): Promise<{ sources: readonly ResolvedVisualSource[]; dispose(): Promise<void> }> {
  if (input.project.schemaVersion === 1) return { sources: [], dispose: async () => undefined };
  const requiredMediaIds = [...new Set(input.project.visualTracks.map((track) => track.mediaId))];
  if (requiredMediaIds.length === 0) return { sources: [], dispose: async () => undefined };
  const mediaById = new Map(input.project.media.assets.map((asset) => [asset.id, asset]));
  const records = new ProjectMediaStore(input.artifactRoot, input.ownerToken);
  const adapter = await createPrivateVisualRasterAdapter({
    libraryRoot: join(input.artifactRoot, "private-media-library"),
  });
  const sources: ResolvedVisualSource[] = [];
  try {
    for (const id of requiredMediaIds) {
      const projectMedia = mediaById.get(id);
      if (
        projectMedia === undefined ||
        (projectMedia.kind !== "image" && projectMedia.kind !== "video")
      ) {
        throw new RangeError("project visual media is unavailable");
      }
      const stored = await records.load(id);
      assertProjectMedia(projectMedia, stored);
      const handle = await adapter.open({
        media: stored,
        expected: expectedMedia(stored),
      });
      sources.push({
        ...handle.source,
        sha256: stored.sha256,
        kind: stored.mediaKind,
        dispose: handle.dispose,
      });
    }
  } catch (error) {
    try {
      await disposeAll(sources);
    } catch (disposeError) {
      throw new AggregateError(
        [error, disposeError],
        "visual media resolution and disposal failed",
      );
    }
    throw error;
  }
  return { sources, dispose: () => disposeAll(sources) };
}
