import { execFile as execFileCallback } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import {
  CONTEXT_SOURCE_INSTRUCTIONS_READ_FAILED,
  READ_MAX_FILE_SIZE_BYTES,
} from "@zcode/contracts";
import { createNodeContextSourceAdapter } from "../src/context/index.js";
import {
  createNodeFileSystemAdapter,
  setRipgrepTimeoutMsForTests,
  setRipgrepWorkerFactoryForTests,
} from "../src/fs/index.js";

const execFile = promisify(execFileCallback);
// Bugfix: 这些测试可能从仓库根或 apps/zcode-cli 子工程启动；fixture 路径必须绑定到当前测试文件位置。
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const GB2312_FIXTURE_PATH = join(TEST_DIR, "..", "..", "..", "tests", "gb2312.js");
const GB2312_THIS_IS_BYTES = Buffer.from([0xd5, 0xe2, 0xca, 0xc7]);
// chmod 拒绝访问只在 POSIX 非 root 用户下生效。
const CAN_DENY_ACCESS = process.platform !== "win32" && process.getuid?.() !== 0;

class HangingRipgrepWorker extends EventEmitter {
  terminated = false;

  terminate(): Promise<number> {
    this.terminated = true;
    queueMicrotask(() => {
      this.emit("exit", 1);
    });
    return Promise.resolve(1);
  }
}

describe("Node file and context adapters", () => {
  it("creates directory parents idempotently through FileSystemPort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-directory-"));
    const path = join(dir, "nested", "memory");
    const fs = createNodeFileSystemAdapter();

    try {
      await expect(fs.createDirectory({ path })).resolves.toEqual({ path });
      await expect(fs.createDirectory({ path })).resolves.toEqual({ path });
      expect((await stat(path)).isDirectory()).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reads and atomically writes text files through FileSystemPort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-port-"));
    const path = join(dir, "nested", "file.txt");
    const fs = createNodeFileSystemAdapter();

    try {
      await fs.writeTextFile({
        path,
        content: "hello",
        createParents: true,
        atomic: true,
      });

      const read = await fs.readTextFile({ path });
      expect(read.content).toBe("hello");
      expect(read.revision?.id).toMatch(/^mtime:/);

      await fs.writeTextFile({
        path,
        content: "updated",
        expectedRevision: read.revision,
      });
      expect(await readFile(path, "utf8")).toBe("updated");

      await expect(fs.removeFile({ path })).resolves.toMatchObject({
        path,
        removed: true,
      });
      await expect(fs.removeFile({ path, missingOk: true })).resolves.toMatchObject({
        path,
        removed: false,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "preserves executable permissions when atomically rewriting existing files",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-fs-mode-"));
      const path = join(dir, "run.sh");
      const fs = createNodeFileSystemAdapter();

      try {
        await writeFile(path, "#!/usr/bin/env bash\necho old\n", "utf8");
        await chmod(path, 0o755);

        await fs.writeTextFile({
          path,
          content: "#!/usr/bin/env bash\necho new\n",
          atomic: true,
        });

        expect(await readFile(path, "utf8")).toBe("#!/usr/bin/env bash\necho new\n");
        expect((await stat(path)).mode & 0o777).toBe(0o755);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects atomic writes through symlink targets",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-fs-symlink-"));
      const targetPath = join(dir, "target.txt");
      const linkPath = join(dir, "link.txt");
      const fs = createNodeFileSystemAdapter();

      try {
        await writeFile(targetPath, "old", "utf8");
        await symlink(targetPath, linkPath);

        await expect(
          fs.writeTextFile({
            path: linkPath,
            content: "new",
            atomic: true,
          }),
        ).rejects.toMatchObject({
          code: "io_error",
          message: `Refusing to write through symlink: ${linkPath}. Resolve the symlink and pass the real target path explicitly.`,
        });

        expect(await readFile(targetPath, "utf8")).toBe("old");
        expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
        expect((await readdir(dir)).filter((entry) => entry.includes(".tmp."))).toEqual([]);
      } finally {
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it("normalizes CRLF reads and preserves requested CRLF writes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-eol-"));
    const path = join(dir, "file.txt");
    const fs = createNodeFileSystemAdapter();

    try {
      await writeFile(path, "alpha\r\nbeta\r\n", "utf8");

      const read = await fs.readTextFile({ path });
      expect(read.content).toBe("alpha\nbeta\n");
      expect(read.lineEndings).toBe("CRLF");
      expect(read.encoding).toBe("utf8");

      await fs.writeTextFile({
        path,
        content: "alpha\ngamma\n",
        encoding: read.encoding,
        lineEndings: read.lineEndings,
        expectedRevision: read.revision,
      });

      expect(await readFile(path, "utf8")).toBe("alpha\r\ngamma\r\n");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reads true line ranges from large files and rejects unbounded over-budget reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-range-"));
    const path = join(dir, "large.txt");
    const fs = createNodeFileSystemAdapter();
    const line = `${"x".repeat(120)}\n`;

    try {
      await writeFile(path, line.repeat(3000), "utf8");

      await expect(
        fs.readTextFileRange({
          path,
          maxBytes: READ_MAX_FILE_SIZE_BYTES,
        }),
      ).rejects.toMatchObject({
        code: "too_large",
        message: expect.stringContaining("maximum allowed size (256KB)"),
      });

      const read = await fs.readTextFileRange({
        path,
        offsetLine: 2500,
        limitLines: 2,
      });

      expect(read.content).toBe(`${"x".repeat(120)}\n${"x".repeat(120)}`);
      expect(read.startLine).toBe(2501);
      expect(read.lineCount).toBe(2);
      expect(read.totalLines).toBe(3001);
      expect(read.sizeBytes).toBeGreaterThan(READ_MAX_FILE_SIZE_BYTES);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("enforces the binary maxBytes contract without returning truncated content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-binary-limit-"));
    const path = join(dir, "video.mp4");
    const fs = createNodeFileSystemAdapter();

    try {
      await writeFile(path, Buffer.from([1, 2, 3]));

      await expect(fs.readBinaryFile({ path, maxBytes: 2 })).rejects.toMatchObject({
        code: "too_large",
      });
      await expect(fs.readBinaryFile({ path, maxBytes: 3 })).resolves.toMatchObject({
        bytesRead: 3,
        sizeBytes: 3,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("continues reading after a non-EOF short binary read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-binary-short-read-"));
    const path = join(dir, "video.mp4");
    const fs = createNodeFileSystemAdapter();
    let readSpy: ReturnType<typeof vi.spyOn> | undefined;

    try {
      await writeFile(path, Buffer.from([1, 2, 3]));
      const probe = await open(path, "r");
      const fileHandlePrototype = Object.getPrototypeOf(probe) as {
        read: typeof probe.read;
      };
      const originalRead = fileHandlePrototype.read;
      await probe.close();
      let firstRead = true;
      readSpy = vi.spyOn(fileHandlePrototype, "read").mockImplementation(async function (
        this: typeof probe,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null,
      ) {
        const readLength = firstRead ? Math.min(1, length) : length;
        firstRead = false;
        return originalRead.call(this, buffer, offset, readLength, position);
      } as never);

      const read = await fs.readBinaryFile({ path, maxBytes: 3 });

      expect(read.content).toEqual(Buffer.from([1, 2, 3]));
      expect(read.bytesRead).toBe(3);
    } finally {
      readSpy?.mockRestore();
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("detects UTF-16LE text files and keeps their line ending metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-utf16-"));
    const path = join(dir, "file.txt");
    const fs = createNodeFileSystemAdapter();

    try {
      await writeFile(path, Buffer.from("\uFEFFalpha\r\nbeta\r\n", "utf16le"));

      const read = await fs.readTextFile({ path });
      expect(read.encoding).toBe("utf16le");
      expect(read.lineEndings).toBe("CRLF");
      expect(read.content).toBe("\uFEFFalpha\nbeta\n");

      await fs.writeTextFile({
        path,
        content: read.content.replace("beta", "gamma"),
        encoding: read.encoding,
        lineEndings: read.lineEndings,
      });

      expect((await readFile(path)).toString("utf16le")).toBe("\uFEFFalpha\r\ngamma\r\n");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reads ranges from the GB2312 fixture as logical Unicode text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-gb2312-read-"));
    const path = join(dir, "gb2312.js");
    const fs = createNodeFileSystemAdapter();

    try {
      await writeFile(path, await readFile(GB2312_FIXTURE_PATH));

      const read = await fs.readTextFile({ path });
      expect(read.encoding).toBe("gb2312");
      expect(read.content).toContain("// 这是一个变量");
      expect(read.content).toContain("// 你好");

      const range = await fs.readTextFileRange({
        path,
        offsetLine: 2,
        limitLines: 3,
      });
      expect(range.encoding).toBe("gb2312");
      expect(range.content).toBe("// 这是一个函数\nfunction go() {\n    return 1");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("preserves GB2312 bytes when rewriting the fixture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-gb2312-write-"));
    const path = join(dir, "gb2312.js");
    const fs = createNodeFileSystemAdapter();

    try {
      await writeFile(path, await readFile(GB2312_FIXTURE_PATH));
      const read = await fs.readTextFile({ path });

      await fs.writeTextFile({
        path,
        content: read.content.replace("return 1", "return 2"),
        encoding: read.encoding,
        lineEndings: read.lineEndings,
        expectedRevision: read.revision,
      });

      const raw = await readFile(path);
      expect(raw.includes(GB2312_THIS_IS_BYTES)).toBe(true);
      expect(raw.includes(Buffer.from("这是", "utf8"))).toBe(false);

      const reread = await fs.readTextFile({ path });
      expect(reread.encoding).toBe("gb2312");
      expect(reread.content).toContain("return 2");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects unencodable GB2312 writes without modifying the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-gb2312-reject-"));
    const path = join(dir, "gb2312.js");
    const fs = createNodeFileSystemAdapter();

    try {
      const originalBytes = await readFile(GB2312_FIXTURE_PATH);
      await writeFile(path, originalBytes);
      const read = await fs.readTextFile({ path });

      await expect(
        fs.writeTextFile({
          path,
          content: `${read.content}\n// 🙂\n`,
          encoding: read.encoding,
          lineEndings: read.lineEndings,
        }),
      ).rejects.toMatchObject({
        code: "unsupported",
      });

      expect(await readFile(path)).toEqual(originalBytes);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("rejects relative file system adapter paths", async () => {
    const fs = createNodeFileSystemAdapter();

    await expect(fs.readTextFile({ path: "relative.txt" })).rejects.toMatchObject({
      code: "invalid_path",
    });
    await expect(
      fs.writeTextFile({
        path: "relative.txt",
        content: "nope",
      }),
    ).rejects.toMatchObject({
      code: "invalid_path",
    });
  });

  it("lists directory entries through FileSystemPort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-list-"));
    const fs = createNodeFileSystemAdapter();

    try {
      await mkdir(join(dir, "src"));
      await writeFile(join(dir, "README.md"), "docs", "utf8");

      const listed = await fs.listDirectory({ path: dir });

      expect(listed.path).toBe(dir);
      expect(listed.numEntries).toBe(2);
      expect(listed.entries).toEqual([
        {
          kind: "file",
          name: "README.md",
          path: join(dir, "README.md"),
        },
        {
          kind: "directory",
          name: "src",
          path: join(dir, "src"),
        },
      ]);

      await expect(fs.listDirectory({ path: join(dir, "README.md") })).rejects.toMatchObject({
        code: "not_file",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("searches files and text through FileSystemPort", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-search-"));
    const fs = createNodeFileSystemAdapter();

    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src", "index.ts"), "export const answer = 42;\n");
      await writeFile(join(dir, "src", "index.test.ts"), "expect(answer).toBe(42);\n");
      await writeFile(join(dir, "README.md"), "# answer\n");

      const files = await fs.searchFiles({
        path: dir,
        pattern: "**/*.ts",
        maxResults: 10,
      });
      const grepFiles = await fs.searchText({
        path: dir,
        pattern: "answer",
        glob: "**/*.ts",
      });
      const grepContent = await fs.searchText({
        path: dir,
        pattern: "answer",
        outputMode: "content",
        headLimit: 1,
      });

      expect(files.files.map((path) => path.slice(dir.length + 1)).sort()).toEqual([
        "src/index.test.ts",
        "src/index.ts",
      ]);
      expect(grepFiles.files.map((path) => path.slice(dir.length + 1)).sort()).toEqual([
        "src/index.test.ts",
        "src/index.ts",
      ]);
      expect(grepFiles.numMatches).toBe(2);
      expect(grepContent.entries).toHaveLength(1);
      expect(grepContent.appliedLimit).toBe(1);
      expect(grepContent.truncated).toBe(true);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("searches text with bundled ripgrep semantics", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-ripgrep-"));
    const fs = createNodeFileSystemAdapter();

    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(
        join(dir, "src", "app.ts"),
        [
          "before",
          "Needle",
          "after",
          'const option = "-flagged";',
          "start",
          "middle",
          "end",
          "",
        ].join("\n"),
      );
      await writeFile(join(dir, "src", "view.tsx"), "needle in tsx\n");
      await writeFile(join(dir, "src", "view.js"), "needle in js\n");
      await writeFile(join(dir, "README.md"), "Needle in docs\n");

      const counts = await fs.searchText({
        path: dir,
        pattern: "needle",
        outputMode: "count",
        ignoreCase: true,
        glob: "src/**/*",
        type: "ts",
        headLimit: 0,
      });
      const dashed = await fs.searchText({
        path: dir,
        pattern: "-flagged",
        outputMode: "content",
        glob: "**/*.ts",
      });
      const context = await fs.searchText({
        path: join(dir, "src", "app.ts"),
        pattern: "Needle",
        outputMode: "content",
        context: 1,
      });
      const onlyMatching = await fs.searchText({
        path: join(dir, "src", "app.ts"),
        pattern: "Needle",
        outputMode: "content",
        onlyMatching: true,
      });
      const multiline = await fs.searchText({
        path: join(dir, "src", "app.ts"),
        pattern: "start\nmiddle",
        outputMode: "content",
        multiline: true,
      });

      expect(counts.numMatches).toBe(2);
      expect(counts.entries.map((entry) => entry.path.slice(dir.length + 1)).sort()).toEqual([
        "src/app.ts",
        "src/view.tsx",
      ]);
      expect(dashed.numMatches).toBe(1);
      expect(dashed.entries[0]).toMatchObject({
        path: join(dir, "src", "app.ts"),
        lineNumber: 4,
        matched: true,
      });
      expect(context.entries.map((entry) => [entry.lineNumber, entry.text, entry.matched])).toEqual(
        [
          [1, "before", false],
          [2, "Needle", true],
          [3, "after", false],
        ],
      );
      expect(onlyMatching.entries.map((entry) => entry.text)).toEqual(["Needle"]);
      expect(multiline.numMatches).toBe(1);
      expect(multiline.entries[0]).toMatchObject({
        path: join(dir, "src", "app.ts"),
        lineNumber: 5,
        matched: true,
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("maps ripgrep regex failures to FileSystemPort invalid_pattern errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-ripgrep-error-"));
    const fs = createNodeFileSystemAdapter();

    try {
      await writeFile(join(dir, "file.txt"), "hello\n");

      await expect(
        fs.searchText({
          path: dir,
          pattern: "[",
          outputMode: "content",
        }),
      ).rejects.toMatchObject({
        code: "invalid_pattern",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("ignores onlyMatching outside content mode in JavaScript grep fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-grep-only-matching-"));
    const fs = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });

    try {
      await writeFile(join(dir, "file.txt"), "foo foo\nfoo\n");

      const result = await fs.searchText({
        path: dir,
        pattern: "foo",
        outputMode: "count",
        onlyMatching: true,
        headLimit: 0,
      });

      expect(result.numMatches).toBe(2);
      expect(result.entries).toEqual([
        {
          path: join(dir, "file.txt"),
          count: 2,
        },
      ]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps context lines and match-line count for onlyMatching content", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-grep-only-matching-context-"));
    const engines = [
      createNodeFileSystemAdapter(),
      createNodeFileSystemAdapter({ textSearchEngine: "javascript" }),
    ];

    try {
      const path = join(dir, "file.txt");
      await writeFile(path, "before\nfoo foo\nafter\n");

      for (const fs of engines) {
        const result = await fs.searchText({
          path,
          pattern: "foo",
          outputMode: "content",
          onlyMatching: true,
          context: 1,
          headLimit: 0,
        });

        expect(result.numMatches).toBe(1);
        expect(
          result.entries.map((entry) => [entry.lineNumber, entry.text, entry.matched]),
        ).toEqual([
          [1, "before", false],
          [2, "foo", true],
          [2, "foo", true],
          [3, "after", false],
        ]);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("expands multiline onlyMatching content into line entries", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-grep-multiline-only-matching-"));
    const engines = [
      createNodeFileSystemAdapter(),
      createNodeFileSystemAdapter({ textSearchEngine: "javascript" }),
    ];
    const cases = [
      {
        content: "before\nstart\nmiddle\nend\n",
        pattern: "start\nmiddle",
        expected: [
          [2, "start", true],
          [3, "middle", true],
        ],
      },
      {
        content: "before\nstart\n\nend\n",
        pattern: "start\n\nend",
        expected: [
          [2, "start", true],
          [4, "end", true],
        ],
      },
      {
        content: "foo\rbar\r",
        pattern: "foo\rbar",
        expected: [[1, "foo\rbar", true]],
      },
      {
        content: "before\r\nfoo\r\nbar\r\nafter\r\n",
        pattern: "foo\r\nbar",
        expected: [
          [2, "foo", true],
          [3, "bar", true],
        ],
      },
      {
        content: "zero\nbefore\nstart\nmiddle\nafter\n",
        pattern: "start\nmiddle",
        context: 1,
        expected: [
          [2, "before", false],
          [3, "start", true],
          [4, "middle", true],
          [5, "after", false],
        ],
      },
    ] as const;

    try {
      for (const [index, testCase] of cases.entries()) {
        const path = join(dir, `file-${index}.txt`);
        await writeFile(path, testCase.content);

        for (const fs of engines) {
          const result = await fs.searchText({
            path,
            pattern: testCase.pattern,
            outputMode: "content",
            multiline: true,
            onlyMatching: true,
            context: testCase.context,
            headLimit: 0,
          });

          expect(result.numMatches).toBe(1);
          expect(
            result.entries.map((entry) => [entry.lineNumber, entry.text, entry.matched]),
          ).toEqual(testCase.expected);
        }
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps zero-length onlyMatching entries aligned between ripgrep and fallback", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-grep-zero-only-matching-"));
    const engines = [
      createNodeFileSystemAdapter(),
      createNodeFileSystemAdapter({ textSearchEngine: "javascript" }),
    ];

    try {
      const path = join(dir, "file.txt");
      await writeFile(path, "foo\nbar\n");

      for (const fs of engines) {
        const result = await fs.searchText({
          path,
          pattern: "^",
          outputMode: "content",
          onlyMatching: true,
          headLimit: 0,
        });

        expect(result.numMatches).toBe(2);
        expect(
          result.entries.map((entry) => [entry.lineNumber, entry.text, entry.matched]),
        ).toEqual([
          [1, "", true],
          [2, "", true],
        ]);
      }
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("maps cancelled grep searches to FileSystemPort cancelled errors", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-grep-cancel-"));
    const fs = createNodeFileSystemAdapter({ textSearchEngine: "javascript" });
    const controller = new AbortController();

    try {
      await writeFile(join(dir, "file.txt"), "hello\n");
      controller.abort();

      await expect(
        fs.searchText(
          {
            path: dir,
            pattern: "hello",
          },
          { signal: controller.signal },
        ),
      ).rejects.toMatchObject({
        code: "cancelled",
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("terminates bundled ripgrep worker when grep search is cancelled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-ripgrep-cancel-"));
    const fs = createNodeFileSystemAdapter();
    const controller = new AbortController();
    const worker = new HangingRipgrepWorker();
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const restoreWorkerFactory = setRipgrepWorkerFactoryForTests(() => {
      resolveStarted();
      return worker;
    });

    try {
      await writeFile(join(dir, "file.txt"), "hello\n");
      const pending = fs.searchText(
        {
          path: dir,
          pattern: "hello",
        },
        { signal: controller.signal },
      );

      await started;
      controller.abort(new Error("user stopped"));

      await expect(pending).rejects.toMatchObject({
        code: "cancelled",
      });
      expect(worker.terminated).toBe(true);
    } finally {
      restoreWorkerFactory();
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("terminates bundled ripgrep worker when grep search times out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-fs-ripgrep-timeout-"));
    const fs = createNodeFileSystemAdapter();
    const worker = new HangingRipgrepWorker();
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      resolveStarted = resolve;
    });
    const restoreWorkerFactory = setRipgrepWorkerFactoryForTests(() => {
      resolveStarted();
      return worker;
    });
    const restoreTimeout = setRipgrepTimeoutMsForTests(10);

    try {
      await writeFile(join(dir, "file.txt"), "hello\n");
      const pending = fs.searchText({
        path: dir,
        pattern: "hello",
      });

      await started;

      await expect(pending).rejects.toMatchObject({
        code: "io_error",
        message: expect.stringContaining("timed out"),
      });
      expect(worker.terminated).toBe(true);
    } finally {
      restoreTimeout();
      restoreWorkerFactory();
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("resolves context sources outside core", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-context-port-"));
    const adapter = createNodeContextSourceAdapter({ env: { HOME: dir, SHELL: "/bin/zsh" } });

    try {
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest" } }));
      await writeFile(join(dir, "pnpm-lock.yaml"), "");
      await writeFile(join(dir, "AGENTS.md"), "project instructions");
      await mkdir(join(dir, ".git"));

      const snapshot = await adapter.resolveContextSources({
        workingDirectory: dir,
        userInstructions: {
          workingDirectory: dir,
        },
      });

      expect(snapshot.envInfo.cwd).toBe(dir);
      expect(snapshot.envInfo.shell).toBe("zsh");
      // 有 .git 就是仓库，与项目根同一个事实；原来按 git 进程判定，空 .git 被当成"不是仓库"。
      expect(snapshot.envInfo.isGitRepository).toBe(true);
      expect(snapshot.userInstructions?.content).toBe("project instructions");
      expect(snapshot.projectContext).toMatchObject({
        type: "node",
        packageManager: "pnpm",
        scripts: { test: "vitest" },
      });
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("uses the effective Bash shell display name when provided by runtime", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-context-shell-"));
    const adapter = createNodeContextSourceAdapter({ env: { HOME: dir, SHELL: "/bin/fish" } });

    try {
      const snapshot = await adapter.resolveContextSources({
        effectiveShellDisplayName: "zsh",
        workingDirectory: dir,
      });

      expect(snapshot.envInfo.shell).toBe("zsh");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("falls back to ~/.zcode/AGENTS.md when workspace AGENTS.md is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-context-home-"));
    const workspace = join(home, "workspace");
    const nestedCwd = join(workspace, "packages", "app");
    const adapter = createNodeContextSourceAdapter({
      env: { HOME: home, SHELL: "/bin/zsh" },
    });

    try {
      await mkdir(nestedCwd, { recursive: true });
      await mkdir(join(workspace, ".git"));
      await mkdir(join(home, ".zcode"), { recursive: true });
      await writeFile(join(home, ".zcode", "AGENTS.md"), "default user instructions");

      const fallbackSnapshot = await adapter.resolveContextSources({
        workingDirectory: nestedCwd,
        userInstructions: {
          workingDirectory: nestedCwd,
        },
      });

      expect(fallbackSnapshot.userInstructions?.filePath).toBe(join(home, ".zcode", "AGENTS.md"));
      expect(fallbackSnapshot.userInstructions?.content).toBe("default user instructions");
      expect(fallbackSnapshot.userInstructions?.sources).toEqual([
        expect.objectContaining({
          scope: "user",
          filePath: join(home, ".zcode", "AGENTS.md"),
          content: "default user instructions",
        }),
      ]);

      await writeFile(join(workspace, "AGENTS.md"), "project instructions");
      const projectSnapshot = await adapter.resolveContextSources({
        workingDirectory: nestedCwd,
        userInstructions: {
          workingDirectory: nestedCwd,
        },
      });

      expect(projectSnapshot.userInstructions?.filePath).toBe(join(workspace, "AGENTS.md"));
      expect(projectSnapshot.userInstructions?.content).toBe(
        "default user instructions\n\nproject instructions",
      );
      expect(projectSnapshot.userInstructions?.sources).toEqual([
        expect.objectContaining({
          scope: "user",
          filePath: join(home, ".zcode", "AGENTS.md"),
          content: "default user instructions",
        }),
        expect.objectContaining({
          scope: "workspace",
          filePath: join(workspace, "AGENTS.md"),
          content: "project instructions",
        }),
      ]);
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  it("uses USERPROFILE for default user instructions when HOME is absent", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-context-userprofile-"));
    const workspace = join(home, "workspace");
    const adapter = createNodeContextSourceAdapter({
      env: { USERPROFILE: home, SHELL: "/bin/zsh" },
    });

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(join(workspace, ".git"));
      await mkdir(join(home, ".zcode"), { recursive: true });
      await writeFile(join(home, ".zcode", "AGENTS.md"), "userprofile instructions");

      const snapshot = await adapter.resolveContextSources({
        workingDirectory: workspace,
        userInstructions: {
          workingDirectory: workspace,
        },
      });

      expect(snapshot.userInstructions?.filePath).toBe(join(home, ".zcode", "AGENTS.md"));
      expect(snapshot.userInstructions?.content).toBe("userprofile instructions");
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  // 修复原因：读取出错原来一律当成文件不存在，调用方把权限错误宣告成文件已删除。
  it.skipIf(!CAN_DENY_ACCESS)(
    "reports an unreadable AGENTS.md as a read failure and a missing one as nothing",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-context-unreadable-"));
      const adapter = createNodeContextSourceAdapter({ env: { HOME: dir, SHELL: "/bin/zsh" } });
      const agentsPath = join(dir, "AGENTS.md");
      const resolveSources = () =>
        adapter.resolveContextSources({
          workingDirectory: dir,
          userInstructions: { workingDirectory: dir },
        });

      try {
        await mkdir(join(dir, ".git"));
        await writeFile(agentsPath, "project instructions");
        await chmod(agentsPath, 0o000);
        const unreadable = await resolveSources();
        expect(unreadable.userInstructions).toBeUndefined();
        expect(unreadable.diagnostics).toEqual([
          expect.objectContaining({
            code: CONTEXT_SOURCE_INSTRUCTIONS_READ_FAILED,
            path: agentsPath,
          }),
        ]);

        await rm(agentsPath, { force: true });
        const missing = await resolveSources();
        expect(missing.userInstructions).toBeUndefined();
        expect(missing.diagnostics).toEqual([]);
      } finally {
        await chmod(agentsPath, 0o644).catch(() => undefined);
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it.skipIf(!CAN_DENY_ACCESS)(
    "stops at an instruction path whose check fails instead of using a parent file",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "zcode-context-locked-"));
      const adapter = createNodeContextSourceAdapter({ env: { HOME: dir, SHELL: "/bin/zsh" } });
      const locked = join(dir, "locked");

      try {
        await mkdir(join(dir, ".git"));
        await writeFile(join(dir, "AGENTS.md"), "parent instructions");
        await mkdir(locked);
        await chmod(locked, 0o000);
        const snapshot = await adapter.resolveContextSources({
          workingDirectory: locked,
          userInstructions: { workingDirectory: locked },
        });
        // 目录不可访问时不知道 locked/AGENTS.md 是否存在：不换成父目录的文件，报读取失败。
        expect(snapshot.userInstructions).toBeUndefined();
        expect(snapshot.diagnostics).toEqual([
          expect.objectContaining({
            code: CONTEXT_SOURCE_INSTRUCTIONS_READ_FAILED,
            path: join(locked, "AGENTS.md"),
          }),
        ]);
      } finally {
        await chmod(locked, 0o755).catch(() => undefined);
        await rm(dir, { force: true, recursive: true });
      }
    },
  );

  it("does not use the default AGENTS.md fallback for custom priority files", async () => {
    const home = await mkdtemp(join(tmpdir(), "zcode-context-priority-"));
    const workspace = join(home, "workspace");
    const adapter = createNodeContextSourceAdapter({
      env: { HOME: home, SHELL: "/bin/zsh" },
    });

    try {
      await mkdir(workspace, { recursive: true });
      await mkdir(join(workspace, ".git"));
      await mkdir(join(home, ".zcode"), { recursive: true });
      await writeFile(join(home, ".zcode", "AGENTS.md"), "default user instructions");

      const snapshot = await adapter.resolveContextSources({
        workingDirectory: workspace,
        userInstructions: {
          workingDirectory: workspace,
          priorityFiles: ["CUSTOM.md"],
        },
      });

      expect(snapshot.userInstructions).toBeUndefined();
    } finally {
      await rm(home, { force: true, recursive: true });
    }
  });

  it("captures a session-start git snapshot when the workspace is a repository", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-context-git-"));
    const adapter = createNodeContextSourceAdapter({ env: { SHELL: "/bin/zsh" } });

    try {
      if (!(await hasGitCli())) {
        return;
      }

      await runGit(dir, ["init"]);
      await runGit(dir, ["checkout", "-B", "main"]);
      await runGit(dir, ["config", "user.name", "ZCode Tester"]);
      await runGit(dir, ["config", "user.email", "tester@example.com"]);

      await writeFile(join(dir, "tracked.txt"), "first\n");
      await runGit(dir, ["add", "tracked.txt"]);
      await runGit(dir, ["commit", "-m", "first commit"]);

      await writeFile(join(dir, "tracked.txt"), "first\nsecond\n");
      await runGit(dir, ["add", "tracked.txt"]);
      await runGit(dir, ["commit", "-m", "second commit"]);

      await writeFile(join(dir, "tracked.txt"), "dirty\n");
      await writeFile(join(dir, "untracked.txt"), "new file\n");

      const snapshot = await adapter.resolveContextSources({
        workingDirectory: dir,
      });

      expect(snapshot.envInfo.shell).toBe("zsh");
      expect(snapshot.envInfo.isGitRepository).toBe(true);
      expect(snapshot.envInfo.gitBranch).toBe("main");
      expect(snapshot.envInfo.gitMainBranch).toBe("main");
      expect(snapshot.envInfo.gitUser).toBe("ZCode Tester");
      expect(snapshot.envInfo.gitStatus).toBe("dirty");
      expect(snapshot.envInfo.gitStatusLines).toEqual(
        expect.arrayContaining(["M tracked.txt", "?? untracked.txt"]),
      );
      expect(snapshot.envInfo.recentCommits?.length).toBe(2);
      expect(snapshot.envInfo.recentCommits?.[0]).toContain("second commit");
      expect(snapshot.envInfo.recentCommits?.[1]).toContain("first commit");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("keeps git status entries until the 2k character boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-context-git-large-"));
    const adapter = createNodeContextSourceAdapter({ env: { SHELL: "/bin/zsh" } });

    try {
      if (!(await hasGitCli())) {
        return;
      }

      await runGit(dir, ["init"]);
      await runGit(dir, ["checkout", "-B", "main"]);
      for (let index = 0; index < 30; index += 1) {
        await writeFile(join(dir, `file-${String(index).padStart(3, "0")}.txt`), "dirty\n");
      }

      const snapshot = await adapter.resolveContextSources({
        workingDirectory: dir,
      });
      const statusLines = snapshot.envInfo.gitStatusLines ?? [];

      expect(snapshot.envInfo.gitStatus).toBe("dirty");
      expect(statusLines).toHaveLength(30);
      expect(statusLines[0]).toBe("?? file-000.txt");
      expect(statusLines[19]).toBe("?? file-019.txt");
      expect(statusLines[29]).toBe("?? file-029.txt");
      expect(statusLines.join("\n")).not.toContain("git status truncated after 20 entries");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("truncates git status by 2k characters with the truncation prompt text", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-context-git-2k-"));
    const adapter = createNodeContextSourceAdapter({ env: { SHELL: "/bin/zsh" } });

    try {
      if (!(await hasGitCli())) {
        return;
      }

      await runGit(dir, ["init"]);
      await runGit(dir, ["checkout", "-B", "main"]);
      for (let index = 0; index < 100; index += 1) {
        await writeFile(
          join(dir, `file-${String(index).padStart(3, "0")}-${"x".repeat(32)}.txt`),
          "dirty\n",
        );
      }

      const snapshot = await adapter.resolveContextSources({
        workingDirectory: dir,
      });
      const statusText = (snapshot.envInfo.gitStatusLines ?? []).join("\n");

      expect(snapshot.envInfo.gitStatus).toBe("dirty");
      expect(statusText).toContain("... (truncated because it exceeds 2k characters.");
      expect(statusText).toContain('run "git status" using Bash');
      expect(statusText).not.toContain("git status truncated after 20 entries");
      expect(statusText.length).toBeGreaterThan(2000);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reads the unborn branch from a nested working directory", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-context-git-unborn-"));
    const adapter = createNodeContextSourceAdapter();
    try {
      await runGit(dir, ["init"]);
      await runGit(dir, ["checkout", "-B", "topic/no-commits"]);
      const nested = join(dir, "nested");
      await mkdir(nested);
      const snapshot = await adapter.resolveContextSources({ workingDirectory: nested });
      expect(snapshot.envInfo.gitBranch).toBe("topic/no-commits");
      expect(snapshot.envInfo.recentCommits).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reads an unborn branch in a linked worktree instead of the parent repository HEAD", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-context-git-worktree-"));
    const adapter = createNodeContextSourceAdapter();
    try {
      await runGit(dir, ["init"]);
      await runGit(dir, ["checkout", "-B", "main"]);
      await runGit(dir, [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ]);
      const worktree = join(dir, "linked");
      await runGit(dir, ["worktree", "add", "-b", "topic/worktree", worktree]);
      // 链接工作树切到还没有提交的分支：rev-parse --abbrev-ref HEAD 在这里以 128 退出、
      // 回退成 HEAD；只有读本工作树符号引用的 symbolic-ref 能得到分支名。
      // 父仓库仍在有提交的 main 上，结果不能是父仓库的 HEAD。
      await runGit(worktree, ["checkout", "--orphan", "topic/unborn-worktree"]);
      const snapshot = await adapter.resolveContextSources({ workingDirectory: worktree });
      expect(snapshot.envInfo.gitBranch).toBe("topic/unborn-worktree");
      expect(snapshot.envInfo.recentCommits).toEqual([]);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("uses the main branch fallback when origin HEAD is unavailable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-context-git-main-fallback-"));
    const adapter = createNodeContextSourceAdapter({ env: { SHELL: "/bin/zsh" } });

    try {
      if (!(await hasGitCli())) {
        return;
      }

      await runGit(dir, ["init"]);
      await runGit(dir, ["checkout", "-B", "feature-only"]);
      await runGit(dir, ["config", "user.name", "ZCode Tester"]);
      await runGit(dir, ["config", "user.email", "tester@example.com"]);
      await writeFile(join(dir, "tracked.txt"), "first\n");
      await runGit(dir, ["add", "tracked.txt"]);
      await runGit(dir, ["commit", "-m", "first commit"]);

      const snapshot = await adapter.resolveContextSources({
        workingDirectory: dir,
      });

      expect(snapshot.envInfo.gitBranch).toBe("feature-only");
      expect(snapshot.envInfo.gitMainBranch).toBe("main");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  it("reports HEAD as the current branch in detached checkout", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zcode-context-git-detached-"));
    const adapter = createNodeContextSourceAdapter({ env: { SHELL: "/bin/zsh" } });

    try {
      if (!(await hasGitCli())) {
        return;
      }

      await runGit(dir, ["init"]);
      await runGit(dir, ["checkout", "-B", "main"]);
      await runGit(dir, ["config", "user.name", "ZCode Tester"]);
      await runGit(dir, ["config", "user.email", "tester@example.com"]);
      await writeFile(join(dir, "tracked.txt"), "first\n");
      await runGit(dir, ["add", "tracked.txt"]);
      await runGit(dir, ["commit", "-m", "first commit"]);
      await runGit(dir, ["checkout", "--detach", "HEAD"]);

      const snapshot = await adapter.resolveContextSources({
        workingDirectory: dir,
      });

      expect(snapshot.envInfo.gitBranch).toBe("HEAD");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});

async function hasGitCli(): Promise<boolean> {
  try {
    await execFile("git", ["--version"], {
      encoding: "utf8",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFile("git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
}
