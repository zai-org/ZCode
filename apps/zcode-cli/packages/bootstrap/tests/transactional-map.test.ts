// TransactionalMap：原子事件事务里共享的大侧表（docs/v4-refactor/02-projection.md「原子事件事务」）。
// 回滚后内容与迭代顺序都必须回到事务开始时；提交后保留事务内的写入，与在副本上做同样操作的结果相同。
import { describe, expect, it, vi } from "vitest";
import { TransactionalMap } from "../src/zcode-protocol-v4/product-projection.js";

type Op = readonly ["set", string, number] | readonly ["delete", string] | readonly ["clear"];

function apply(map: Map<string, number>, ops: readonly Op[]): void {
  for (const op of ops) {
    if (op[0] === "set") map.set(op[1], op[2]);
    else if (op[0] === "delete") map.delete(op[1]);
    else map.clear();
  }
}

const START: ReadonlyArray<readonly [string, number]> = [
  ["a", 1],
  ["b", 2],
  ["c", 3],
];

// 每组覆盖一种会影响顺序或内容的写入组合。
const CASES: ReadonlyArray<readonly [string, readonly Op[]]> = [
  [
    "只新增",
    [
      ["set", "d", 4],
      ["set", "e", 5],
    ],
  ],
  [
    "改写已有键",
    [
      ["set", "b", 20],
      ["set", "b", 21],
    ],
  ],
  ["删除已有键", [["delete", "a"]]],
  [
    "删除后重新加入已有键（位置移到末尾）",
    [
      ["delete", "a"],
      ["set", "a", 10],
    ],
  ],
  [
    "先改写再删除已有键",
    [
      ["set", "b", 20],
      ["delete", "b"],
      ["set", "d", 4],
    ],
  ],
  [
    "新增后删除新增键",
    [
      ["set", "d", 4],
      ["delete", "d"],
      ["set", "d", 5],
    ],
  ],
  [
    "先新增再删除已有键",
    [
      ["set", "d", 4],
      ["set", "c", 30],
      ["delete", "a"],
      ["set", "e", 5],
    ],
  ],
  [
    "删除不存在的键",
    [
      ["delete", "zz"],
      ["set", "d", 4],
    ],
  ],
  ["清空后重建", [["set", "b", 20], ["clear"], ["set", "c", 3], ["set", "a", 1]]],
];

describe("TransactionalMap", () => {
  it.each(CASES)("%s：回滚恢复内容与顺序，提交与副本上的结果相同", (_label, ops) => {
    const rolledBack = new TransactionalMap<string, number>(START);
    rolledBack.beginTransaction();
    apply(rolledBack, ops);
    rolledBack.rollbackTransaction();
    expect([...rolledBack]).toEqual(START);

    const committed = new TransactionalMap<string, number>(START);
    committed.beginTransaction();
    apply(committed, ops);
    committed.commitTransaction();
    const copy = new Map<string, number>(START);
    apply(copy, ops);
    expect([...committed]).toEqual([...copy]);
  });

  it("事务外的写入不记录；回滚只撤销本次事务", () => {
    const map = new TransactionalMap<string, number>(START);
    map.set("d", 4);
    map.beginTransaction();
    map.set("e", 5);
    map.rollbackTransaction();
    expect([...map]).toEqual([...START, ["d", 4]]);

    map.beginTransaction();
    map.delete("a");
    map.commitTransaction();
    map.beginTransaction();
    map.set("f", 6);
    map.rollbackTransaction();
    expect([...map]).toEqual([
      ["b", 2],
      ["c", 3],
      ["d", 4],
    ]);
  });

  it("回滚中途抛错时事务已经关闭，可以重新开启", () => {
    // 原子事件结束时逐张回滚；某张表回滚抛错后，它自己也不能残留事务，否则之后每个事件都会失败。
    const map = new TransactionalMap<string, number>(START);
    map.beginTransaction();
    map.set("b", 20);
    map.set("d", 4);
    const restoreSet = vi.spyOn(Map.prototype, "set").mockImplementationOnce(() => {
      throw new RangeError("injected restore failure");
    });
    let thrown: unknown;
    try {
      map.rollbackTransaction();
    } catch (error) {
      thrown = error;
    } finally {
      restoreSet.mockRestore();
    }
    expect(thrown).toBeInstanceOf(RangeError);
    expect(() => map.beginTransaction()).not.toThrow();
    map.rollbackTransaction();
  });

  it("不能嵌套开启事务", () => {
    const map = new TransactionalMap<string, number>();
    map.beginTransaction();
    expect(() => map.beginTransaction()).toThrow();
  });
});
