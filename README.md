# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

SQLite数据库文件会在首次启动时创建到`data/app.db`。

## 档案纠错单（corrections）

偶头/配件的剧目（play）、角色（role）、箱号（boxNo）发现登记错误时，不直接改档，
统一走纠错单，避免旧巡演单和修补履历串档。

- `POST /api/corrections` 提交纠错单
  - 入参：`{ targetCollection, targetId, changes: [{field, newValue}], evidence: {type, ref, note, attachments}, submitter, reason }`
  - 凭证支持 `evidence` 对象/字符串或 `source`；必须有来源编号 `ref` 或附件 `attachments`，仅有说明不算凭证。
  - 规则：
    - 凭证缺失或新值与当前档案相同：单据落为「已退回」并写明退回原因（HTTP 200），留存可查。
    - 同一件已有「待审核」单：重复提交沿用首次结果，返回 `duplicate: true`。
    - 退回/审结后可再次提交，会生成新单。
- `POST /api/corrections/:id/approve` 审核通过，入参 `{ reviewer }`
  - 当前档案按新值显示；旧值写入字段留痕（`field_history`）并登记「纠错通过」履历，继续可查。
  - 尚未结束的巡演装箱单（草稿/已装箱/巡演中/返场清点中）和缺损单（待处理/修复中）转为「待复核」，
    记录 `pendingReview` 标记（原状态、纠错单编号）；已闭环、已补齐、确认为遗失等已完成记录不改。
  - 审核期间字段已被改对的，该字段跳过；若全部字段都已与当前档案一致，整单退回。
  - 重复审核返回 409，并随首次处理结果。
- `POST /api/corrections/:id/return` 审核退回，入参 `{ reviewer, reason }`
- `GET /api/corrections?status=&targetCollection=&targetId=` 查询纠错单
- `GET /api/corrections/:id` 纠错单详情
- 旧值查询：
  - `GET /api/:collection/:id/timeline` 返回履历事件与 `fieldHistory`（每次字段纠错的旧值、新值、凭证）

代码按职责分三层：`lib/routes/corrections.js` 接口入口、`lib/review.js` 审核规则、
`lib/correctionStore.js` 与 `lib/records.js` 存储。
