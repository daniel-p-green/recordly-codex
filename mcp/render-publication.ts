import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const fileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value.length > 0 && !value.startsWith("..") && !isAbsolute(value);
}

function isNotFound(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function privateDirectory(path: string, root: string, label: string): Promise<string> {
  const status = await lstat(path);
  if (!status.isDirectory() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new RangeError(`${label} must be a private non-symlink directory`);
  }
  const resolved = await realpath(path);
  if (path !== root && !contained(root, resolved))
    throw new RangeError(`${label} escapes artifact root`);
  return resolved;
}

async function privateRegularFile(path: string, root: string, label: string): Promise<string> {
  const status = await lstat(path);
  if (!status.isFile() || status.isSymbolicLink() || (status.mode & 0o077) !== 0) {
    throw new RangeError(`${label} must be a private regular file`);
  }
  const resolved = await realpath(path);
  if (!contained(root, resolved)) throw new RangeError(`${label} escapes render root`);
  return resolved;
}

export type RenderPublication = {
  outputPath: string;
  temporaryPath: string;
  stagingRoot: string;
  publish: () => Promise<void>;
  unpublish: () => Promise<void>;
  cleanup: () => Promise<void>;
};

/** Publishes only a verified candidate, and rolls it back if the guarded project write loses its CAS. */
export async function publishThenCompareAndSwap<T>(
  publication: Pick<RenderPublication, "publish" | "unpublish">,
  compareAndSwap: () => Promise<T>,
): Promise<T> {
  await publication.publish();
  try {
    return await compareAndSwap();
  } catch (error) {
    await publication.unpublish();
    throw error;
  }
}

/** Creates an exclusive private candidate, then atomically publishes it only to a safe render path. */
export async function createRenderPublication(input: {
  artifactRoot: string;
  fileName: string;
}): Promise<RenderPublication> {
  if (
    !isAbsolute(input.artifactRoot) ||
    input.artifactRoot === "/" ||
    !fileName.test(input.fileName)
  ) {
    throw new RangeError("render publication input is invalid");
  }
  const artifactRoot = await privateDirectory(
    resolve(input.artifactRoot),
    resolve(input.artifactRoot),
    "artifact root",
  );
  const projectsRoot = join(artifactRoot, "projects");
  await mkdir(projectsRoot, { recursive: true, mode: DIRECTORY_MODE });
  const projects = await privateDirectory(projectsRoot, artifactRoot, "projects directory");
  await chmod(projects, DIRECTORY_MODE);
  await privateDirectory(projects, artifactRoot, "projects directory");
  const renderRoot = join(projects, "renders");
  await mkdir(renderRoot, { recursive: true, mode: DIRECTORY_MODE });
  const renders = await privateDirectory(renderRoot, artifactRoot, "render directory");
  await chmod(renders, DIRECTORY_MODE);
  await privateDirectory(renders, artifactRoot, "render directory");
  const outputPath = resolve(renders, input.fileName);
  if (!contained(renders, outputPath)) throw new RangeError("render output escapes render root");
  const extension = input.fileName.slice(input.fileName.lastIndexOf("."));
  const temporaryPath = join(renders, `.${input.fileName}.${randomUUID()}.tmp${extension}`);
  await writeFile(temporaryPath, "", { mode: FILE_MODE, flag: "wx" });
  await privateRegularFile(temporaryPath, renders, "render candidate");
  const stagingRoot = await mkdtemp(join(renders, ".frame-staging-"));
  await privateDirectory(stagingRoot, renders, "render staging directory");
  await chmod(stagingRoot, DIRECTORY_MODE);
  await privateDirectory(stagingRoot, renders, "render staging directory");
  let published: { dev: number; ino: number } | undefined;

  return {
    outputPath,
    temporaryPath,
    stagingRoot,
    publish: async () => {
      await privateRegularFile(temporaryPath, renders, "render candidate");
      try {
        const destination = await lstat(outputPath);
        if (destination.isSymbolicLink())
          throw new RangeError("render destination must not be a symlink");
        if (!destination.isFile() || (destination.mode & 0o077) !== 0)
          throw new RangeError("render destination must be a private regular file");
        throw new RangeError("render destination already exists");
      } catch (error) {
        if (!isNotFound(error)) throw error;
      }
      await rename(temporaryPath, outputPath);
      await chmod(outputPath, FILE_MODE);
      await privateRegularFile(outputPath, renders, "published render");
      const status = await lstat(outputPath);
      published = { dev: status.dev, ino: status.ino };
    },
    unpublish: async () => {
      if (published === undefined) return;
      const status = await lstat(outputPath);
      if (
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.dev !== published.dev ||
        status.ino !== published.ino
      ) {
        throw new RangeError("published render changed before rollback");
      }
      await privateRegularFile(outputPath, renders, "published render");
      await unlink(outputPath);
      published = undefined;
    },
    cleanup: async () => {
      await rm(temporaryPath, { force: true });
      await rm(stagingRoot, { recursive: true, force: true });
    },
  };
}
