import { readFileSync } from "node:fs";

// 被开源导出的 SEA 打包脚本复用；build-cua-helper-app.mjs 不导出到开源树，不能从那里取。
export const MACHO_ARCH_BY_CPU_TYPE = new Map([
  [0x01000007, "x64"],
  [0x0100000c, "arm64"],
]);
export const THIN_MACHO_MAGIC = new Map([
  ["feedface", "be"],
  ["feedfacf", "be"],
  ["cefaedfe", "le"],
  ["cffaedfe", "le"],
]);
export const FAT_MACHO_MAGIC = new Map([
  ["cafebabe", { endian: "be", archBytes: 20 }],
  ["cafebabf", { endian: "be", archBytes: 32 }],
  ["bebafeca", { endian: "le", archBytes: 20 }],
  ["bfbafeca", { endian: "le", archBytes: 32 }],
]);

export function readU32(buffer, offset, endian) {
  return endian === "be" ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset);
}

export function readMachOArchs(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length < 8) {
    throw new Error(`Mach-O provenance check failed for ${filePath}: file is too small`);
  }

  const magic = buffer.subarray(0, 4).toString("hex");
  const thinEndian = THIN_MACHO_MAGIC.get(magic);
  if (thinEndian) {
    const arch = MACHO_ARCH_BY_CPU_TYPE.get(readU32(buffer, 4, thinEndian));
    return arch ? [arch] : [];
  }

  const fat = FAT_MACHO_MAGIC.get(magic);
  if (!fat) return [];

  const archCount = readU32(buffer, 4, fat.endian);
  const archs = [];
  for (let index = 0; index < archCount; index += 1) {
    const offset = 8 + index * fat.archBytes;
    if (offset + 4 > buffer.length) break;
    const arch = MACHO_ARCH_BY_CPU_TYPE.get(readU32(buffer, offset, fat.endian));
    if (arch && !archs.includes(arch)) archs.push(arch);
  }
  return archs;
}

const PE_ARCH_BY_MACHINE = new Map([
  [0x8664, "x64"],
  [0xaa64, "arm64"],
]);

export function readPeArchs(filePath) {
  const buffer = readFileSync(filePath);
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") return [];
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset > buffer.length - 6 || buffer.toString("binary", peOffset, peOffset + 4) !== "PE\u0000\u0000") {
    return [];
  }
  const arch = PE_ARCH_BY_MACHINE.get(buffer.readUInt16LE(peOffset + 4));
  return arch ? [arch] : [];
}
