# Music For U

基于微信云开发的单房间音乐聊天室小程序。

## 当前架构

- 微信身份：云函数通过 `OPENID` 自动识别用户。
- 业务服务：`cloudfunctions/musicApp` 统一处理用户、消息、歌曲队列和收藏。
- 数据存储：云数据库保存用户、默认房间、消息、播放队列和歌曲收藏。
- 实时同步：客户端通过云数据库 `watch` 监听消息和当前歌曲。
- 文件资源：头像、聊天图片和语音上传到云存储。
- 房间模型：仅保留一个默认房间，不提供创建、搜索和切换房间。
- 房主规则：首位访问并创建默认房间的用户成为唯一房主。
- 消息能力：支持文字、图片、语音和引用回复，不提供审核或举报流程。

## 项目入口

- 云开发迁移与部署说明：[docs/cloud-development.md](docs/cloud-development.md)
- 完整 Code Wiki：[docs/code-wiki/README.md](docs/code-wiki/README.md)
- 云函数入口：[cloudfunctions/musicApp/index.js](cloudfunctions/musicApp/index.js)

## 音乐接口

计划接入 `https://www.hanxin.vip/api/music`。该地址目前在常见参数组合下返回空响应，歌曲搜索适配需要接口参数、鉴权方式和响应示例才能完成。其他云开发业务已与该适配器解耦。
