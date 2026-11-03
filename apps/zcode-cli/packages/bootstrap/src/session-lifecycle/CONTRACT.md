# Session 生命周期 owner

唯一拥有运行实例的生命周期和在途操作。公开接口见 contract.ts；产品语义见
[生命周期规格](../../../../docs/design/v2/session-runtime-lifecycle.md)。

宿主提供存在性读取、初始化、同步停止预检、资源释放和状态观察。模块不访问数据库、
网络、timer 或协议 gateway。每个 session 独立协调；重启覆盖整个关闭和恢复区间。
initialize/dispose 是装配层迁移已有创建、分叉和释放入口的内部接口，不向客户端开放。
调用方保留 operation lease，保证初始化完成后的业务命令不被容量回收抢占。

faulted 隔离当前实例；后续调用不能再次初始化或盲目重试释放。进程重建是上层出口。

启动输入带可选 workspace，flight 固定该上下文；Host 校验发生在 restart 释放前。
close Promise 表达真实完成，等待超时由调用方管理。状态与接口的升级兼容见主规格。

所有内部初始化入口登记 workspace；仅新建入口使用 create 模式，跳过尚无持久记录的恢复校验。
旧无上下文启动的加入者仍在完成后验证归属，不以共享结果替代校验。
