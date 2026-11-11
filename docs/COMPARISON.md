# 与 MusicParty / mpsync 的关系

> 很多人问「已经有 MusicParty 了为什么还要这个」——这篇把定位、能力、适用场景讲清楚。

[MusicParty/mpsync](https://github.com/zihe114514/mpsync) 是另一套「服务器一起听」实现（服务端 mod + 开放线协议，
配套客户端 MuoniumPlayer）。两者**协议不兼容**、面向的客户端也不同，但思路互相借鉴，本项目从它那里学了几件事：

| 借鉴点 | 本项目里的落地 |
| --- | --- |
| 运维视角（他们的 `/mp list` 给 OP 看全部房间、能踢人关房） | `GET /admin/rooms`、`DELETE /admin/rooms/<码>`、`GET /admin/stats` |
| 校验与安全默认值（他们校验直链时长、平台白名单） | 照 Firebase 规则的 `.validate` 做字段校验 + 单次写入 32 KB 上限 |
| 时钟纪律（他们文档里 soft/hard 漂移 + 冷却的三档策略） | 服务端改用单调时钟，系统时间调整不会让时间戳回跳 |
| 「core 不许碰 Minecraft」的编译期守卫 | 测试断言 `server.mjs` 只 import `node:` 内置模块、零依赖 |
| 开放协议文档（他们的 `docs/接入指南.md`） | 本项目的 [docs/PROTOCOL.md](docs/PROTOCOL.md)：客户端实际发了什么、服务器该回什么 |

差异：mpsync 的房间是**全服共享**、服务端权威调度、会员解析的直链全房共享；DangoMusic 的房间是
**按房间码的私有房**、每台客户端用自己的账号取流。后者是客户端写死的协议，服务端改不了，
所以本项目只做「把 Firebase 换掉」，不试图改播放模型。
