import { createRequire } from "node:module";
import { access, readFile } from "node:fs/promises";
import { dirname, posix, resolve } from "node:path";

export function placeRuntimePackage({ packageName, packageDirectory, fromAssetPath, placements }) {
  // 原收集器仅按包名去重，把 contracts 的 Zod 3 和 shared 的 Zod 4 压成同一个包。
  // 按消费者的 Node 查找顺序复用同一物理包；冲突版本放入消费者自己的 node_modules。
  let directory = fromAssetPath;
  while (true) {
    const candidate = posix.join(directory, "node_modules", packageName);
    const existing = placements.get(candidate);
    if (existing) {
      if (existing === packageDirectory) return undefined;
      break;
    }
    if (directory === ".") break;
    directory = posix.dirname(directory);
  }
  const rootPath = posix.join("node_modules", packageName);
  const assetPath = placements.has(rootPath)
    ? posix.join(fromAssetPath, "node_modules", packageName)
    : rootPath;
  placements.set(assetPath, packageDirectory);
  return assetPath;
}

export const resolveRuntimePackageDirectory = async ({
  fromDirectory,
  packageName,
  root,
  workspacePackageDirectories,
}) => {
  const workspacePackageDirectory = workspacePackageDirectories.get(packageName);
  if (workspacePackageDirectory) {
    const directory = workspacePackageDirectory;
    await assertPackageDirectory(packageName, directory);
    // 原检查要求 dist/index.js。shared 依赖 session-control 后，session-control 进入 TUI 闭包；
    // 但它只有子路径导出，不会生成 dist/index.js，build:sea 因此必然失败。
    // SEA 运行时只加载 @zcode/tui/dist/index.js（esbuild 已内联全部 @zcode/* 源码），
    // 闭包中其他 workspace 包的 dist 不会被加载，所以这里只确认包已构建，不校验具体入口。
    if (!(await exists(resolve(directory, "dist")))) {
      throw new Error(
        `Missing ${packageName} dist files. Run \`pnpm build:sea:prepare\` from the repository root before \`pnpm sea\`.`,
      );
    }
    return directory;
  }

  const require = createRequire(resolve(fromDirectory ?? root, "package.json"));
  try {
    try {
      return dirname(require.resolve(`${packageName}/package.json`));
    } catch (error) {
      if (error?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") {
        throw error;
      }
      return await findPackageRoot(require.resolve(packageName), packageName);
    }
  } catch (error) {
    const packageDirectory = await resolvePackageRootFromNodeModules({
      fromDirectory,
      packageName,
      root,
    });
    if (packageDirectory) {
      return packageDirectory;
    }
    throw new Error(
      `Missing SEA TUI runtime package ${packageName}. Run \`pnpm install\` and try again.`,
      {
        cause: error,
      },
    );
  }
};

const resolvePackageRootFromNodeModules = async ({ fromDirectory, packageName, root }) => {
  const packagePathSegments = packageName.split("/");

  for (const directory of ancestorDirectories(resolve(fromDirectory ?? root))) {
    const packageDirectory = resolve(directory, "node_modules", ...packagePathSegments);
    if (await exists(resolve(packageDirectory, "package.json"))) {
      return packageDirectory;
    }
  }

  return undefined;
};

function* ancestorDirectories(startDirectory) {
  let directory = startDirectory;

  while (true) {
    yield directory;
    const parentDirectory = dirname(directory);
    if (parentDirectory === directory) {
      return;
    }
    directory = parentDirectory;
  }
}

const findPackageRoot = async (entryPath, packageName) => {
  let directory = dirname(entryPath);

  while (directory !== dirname(directory)) {
    const packageJsonPath = resolve(directory, "package.json");
    if (await exists(packageJsonPath)) {
      const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
      if (packageJson.name === packageName) {
        return directory;
      }
    }
    directory = dirname(directory);
  }

  throw new Error(`Could not find package root for ${packageName} from ${entryPath}`);
};

const assertPackageDirectory = async (packageName, directory) => {
  if (!(await exists(resolve(directory, "package.json")))) {
    throw new Error(`Missing package.json for ${packageName} at ${directory}`);
  }
};

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
