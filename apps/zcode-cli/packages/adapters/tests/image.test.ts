import { describe, expect, it } from "vitest";
import { Jimp, JimpMime, rgbaToInt } from "jimp";
import { createJimpImageProcessorAdapter } from "../src/image/index.js";

describe("Jimp image processor adapter", () => {
  it("resizes images so the longest edge is within the requested dimension", async () => {
    const input = await createPng(3000, 1000, 0x2060a0ff);

    const result = await createJimpImageProcessorAdapter().resizeToFit({
      data: input,
      maxDimension: 2048,
      mediaType: "image/png",
    });
    const metadata = await Jimp.read(Buffer.from(result.data));

    expect(result.resized).toBe(true);
    expect(result.mediaType).toBe("image/png");
    expect(result.originalWidth).toBe(3000);
    expect(result.originalHeight).toBe(1000);
    expect(result.width).toBeLessThanOrEqual(2048);
    expect(result.height).toBeLessThanOrEqual(2048);
    expect(metadata.bitmap.width).toBeLessThanOrEqual(2048);
    expect(metadata.bitmap.height).toBeLessThanOrEqual(2048);
  });

  it("returns the original bytes when an image already fits", async () => {
    const input = await createPng(64, 32, 0x0c2238ff);

    const result = await createJimpImageProcessorAdapter().resizeToFit({
      data: input,
      maxDimension: 2048,
      mediaType: "image/png",
    });

    expect(result.resized).toBe(false);
    expect(Buffer.from(result.data).equals(input)).toBe(true);
    expect(result.width).toBe(64);
    expect(result.height).toBe(32);
  });

  it.each([JimpMime.png, JimpMime.jpeg, JimpMime.gif])(
    "rejects truncated %s data instead of returning the original bytes",
    async (mediaType) => {
      // Bash 图片输出依赖这条契约：解码失败必须抛错，坏图才不会作为 image block 发给 provider。
      const input = await new Jimp({ color: 0x0c2238ff, height: 32, width: 64 }).getBuffer(
        mediaType,
      );
      const adapter = createJimpImageProcessorAdapter();

      // 先确认完整图片能解码，失败只能归因于截断。
      await expect(
        adapter.resizeToFit({ data: input, maxDimension: 2048, mediaType }),
      ).resolves.toMatchObject({ width: 64, height: 32 });
      await expect(
        adapter.resizeToFit({
          data: input.subarray(0, Math.floor(input.length / 2)),
          maxDimension: 2048,
          mediaType,
        }),
      ).rejects.toThrow();
    },
  );

  it("passes WebP through because the Jimp adapter does not encode WebP", async () => {
    const input = Buffer.from("webp-bytes");

    const result = await createJimpImageProcessorAdapter().resizeToFit({
      data: input,
      maxDimension: 2048,
      mediaType: "image/webp",
    });

    expect(result.resized).toBe(false);
    expect(result.mediaType).toBe("image/webp");
    expect(Buffer.from(result.data).equals(input)).toBe(true);
    expect(result.width).toBeUndefined();
    expect(result.height).toBeUndefined();
  });

  it("keeps model images original when dimensions and budgets already fit", async () => {
    const input = await createPng(64, 32, 0x0c2238ff);

    const result = await createJimpImageProcessorAdapter().prepareForModel({
      data: input,
      maxBase64Bytes: 1024 * 1024,
      maxDimension: 2048,
      maxRawBytes: 1024 * 1024,
      mediaType: "image/png",
    });

    expect(result.strategy).toBe("original");
    expect(result.compressed).toBe(false);
    expect(result.resized).toBe(false);
    expect(result.transformedSizeBytes).toBe(input.byteLength);
    expect(Buffer.from(result.data).equals(input)).toBe(true);
  });

  it("resizes model images before returning them when the longest edge is too large", async () => {
    const input = await createPng(3000, 1000, 0x2060a0ff);

    const result = await createJimpImageProcessorAdapter().prepareForModel({
      data: input,
      maxBase64Bytes: 10 * 1024 * 1024,
      maxDimension: 2048,
      maxRawBytes: 10 * 1024 * 1024,
      mediaType: "image/png",
    });

    expect(result.resized).toBe(true);
    expect(result.originalWidth).toBe(3000);
    expect(result.originalHeight).toBe(1000);
    expect(result.width).toBeLessThanOrEqual(2048);
    expect(result.height).toBeLessThanOrEqual(2048);
    expect(result.originalSizeBytes).toBe(input.byteLength);
    expect(result.transformedSizeBytes).toBe(
      Buffer.from(result.data).byteLength,
    );
  });

  it("tries compression candidates until model image byte budgets fit", async () => {
    const input = await createNoisyPng(512, 512);
    const maxRawBytes = 100_000;

    const result = await createJimpImageProcessorAdapter().prepareForModel({
      data: input,
      maxBase64Bytes: 140_000,
      maxDimension: 2048,
      maxRawBytes,
      mediaType: "image/png",
    });

    expect(result.compressed).toBe(true);
    expect(result.resized).toBe(false);
    expect(result.originalSizeBytes).toBe(input.byteLength);
    expect(result.transformedSizeBytes).toBeLessThanOrEqual(maxRawBytes);
    expect(Buffer.from(result.data).byteLength).toBe(
      result.transformedSizeBytes,
    );
  });

  it("switches an over-budget PNG to JPEG without reducing dimensions when JPEG fits", async () => {
    const width = 256;
    const height = 256;
    const input = await createNoisyPng(width, height);
    const image = await Jimp.read(input);
    const optimizedPng = await image.getBuffer(JimpMime.png, {
      deflateLevel: 9,
      deflateStrategy: 3,
    });
    const jpegCandidates = await Promise.all(
      [80, 60, 40, 20].map((quality) =>
        image.getBuffer(JimpMime.jpeg, { quality }),
      ),
    );
    const firstFittingJpeg = jpegCandidates.find(
      (candidate) => candidate.byteLength < optimizedPng.byteLength,
    );

    expect(firstFittingJpeg).toBeDefined();
    const maxRawBytes = firstFittingJpeg?.byteLength ?? 0;

    const result = await createJimpImageProcessorAdapter().prepareForModel({
      data: input,
      maxBase64Bytes: base64LengthForRawBytes(maxRawBytes),
      maxDimension: 2048,
      maxRawBytes,
      mediaType: "image/png",
    });

    expect(result.mediaType).toBe("image/jpeg");
    expect(result.strategy).toBe("jpeg-quality");
    expect(result.width).toBe(width);
    expect(result.height).toBe(height);
    expect(result.resized).toBe(false);
  });

  it("uses only resized JPEG candidates after an original-size PNG exceeds the budget", async () => {
    const width = 512;
    const height = 512;
    const input = await createNoisyPng(width, height);
    const image = await Jimp.read(input);
    const smallestOriginalJpeg = await image.getBuffer(JimpMime.jpeg, {
      quality: 20,
    });
    const maxRawBytes = smallestOriginalJpeg.byteLength - 1;

    const result = await createJimpImageProcessorAdapter().prepareForModel({
      data: input,
      maxBase64Bytes: base64LengthForRawBytes(maxRawBytes),
      maxDimension: 2048,
      maxRawBytes,
      mediaType: "image/png",
    });

    expect(result.mediaType).toBe("image/jpeg");
    expect(result.strategy).toMatch(/^jpeg-/u);
    expect(result.width).toBeLessThan(width);
    expect(result.height).toBeLessThan(height);
    expect(result.resized).toBe(true);
  });

  it("compresses a tall browser screenshot PNG below the 200 KiB base64 budget", async () => {
    const input = await createNoisyPng(320, 2400);
    const maxBase64Bytes = 200 * 1024;
    const maxDimension = 2000;
    const maxRawBytes = Math.floor((maxBase64Bytes * 3) / 4);

    const result = await createJimpImageProcessorAdapter().prepareForModel({
      data: input,
      maxBase64Bytes,
      maxDimension,
      maxRawBytes,
      mediaType: "image/png",
    });
    const transformed = Buffer.from(result.data);

    expect(input.toString("base64").length).toBeGreaterThan(maxBase64Bytes);
    expect(transformed.toString("base64").length).toBeLessThanOrEqual(
      maxBase64Bytes,
    );
    expect(transformed.byteLength).toBeLessThanOrEqual(maxRawBytes);
    expect(Math.max(result.width ?? 0, result.height ?? 0)).toBeLessThanOrEqual(
      maxDimension,
    );
    expect(result.compressed).toBe(true);
    expect(result.mediaType).toBe("image/jpeg");
  });

  it("rejects empty model image inputs before decoding", async () => {
    await expect(
      createJimpImageProcessorAdapter().prepareForModel({
        data: Buffer.alloc(0),
        maxBase64Bytes: 1024,
        maxDimension: 2048,
        maxRawBytes: 1024,
        mediaType: "image/png",
      }),
    ).rejects.toMatchObject({
      code: "empty",
    });
  });

  it("rejects over-budget WebP inputs because this adapter cannot transcode WebP", async () => {
    const webpBytes = Buffer.concat([
      Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      Buffer.alloc(32),
    ]);

    await expect(
      createJimpImageProcessorAdapter().prepareForModel({
        data: webpBytes,
        maxBase64Bytes: 12,
        maxDimension: 2048,
        maxRawBytes: 8,
        mediaType: "image/webp",
      }),
    ).rejects.toMatchObject({
      code: "unsupported",
    });
  });
});

async function createPng(
  width: number,
  height: number,
  color: number,
): Promise<Buffer> {
  const image = new Jimp({ color, height, width });
  return await image.getBuffer(JimpMime.png);
}

async function createNoisyPng(width: number, height: number): Promise<Buffer> {
  const image = new Jimp({ color: 0xffffffff, height, width });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const red = (x * 31 + y * 17) & 0xff;
      const green = (x * 13 + y * 47) & 0xff;
      const blue = (x * 53 + y * 7) & 0xff;
      image.setPixelColor(rgbaToInt(red, green, blue, 255), x, y);
    }
  }
  return await image.getBuffer(JimpMime.png);
}

function base64LengthForRawBytes(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}
