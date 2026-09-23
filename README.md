# 传统木偶戏班偶头与巡演装箱API

维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。

## 启动

```bash
npm install
npm start
```

默认地址：http://localhost:3914

数据库为 SQLite（经 `sql.js` 纯 WASM 驱动，无需本地 sqlite3），首次启动时创建到 `data/app.db`，每次写操作落盘。

## 常用接口

- `GET /api/puppetHeads?play=火焰山&status=可演出`
- `POST /api/repairRecords`
- `POST /api/tourBoxes`
- `POST /api/lossReports`
- `GET /api/:collection/:id/timeline`

## 档案纠错单

偶头或配件的**剧目、角色、箱号**写错时，不直接改档，而是提交纠错单走审核，避免旧巡演单和修补履历串档。

### 规则

- 同一件档案同时只留一份**待审**单；再来一单（内容不同）返回 `409` 并带出已有单号。
- 重复提交（同一件、同一批字段→新值、同一凭证）沿用首次处理结果，返回 `200 {"reused": true}`，不新建单据。
- 提交即退回（`422`，单据留档为「已退回」）：
  - 任一字段缺少来源凭证 `evidence`；
  - 任一字段新值与当前档案相同。
- 审核通过后：
  - 旧值继续可查（纠错单快照 + 档案履历「档案纠错通过」事件，含旧值、新值、凭证）；
  - 当前档案按新值显示，标题随之更新，状态字段不动；
  - 尚未结束的巡演装箱单、缺损单转为「待复核」；已闭环/已补齐/确认为遗失的记录不改；
  - 已通过、已退回的纠错单不能再次审核。
- 审核退回必须写明原因（`reviewNote`）。

### 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/corrections` | 提交纠错单 |
| GET | `/api/corrections?status=待审&targetCollection=puppetHeads&targetId=...` | 列表筛选 |
| GET | `/api/corrections/:id` | 详情（旧值快照、目标档案当前值、审核履历） |
| POST | `/api/corrections/:id/approve` | 审核通过（落新值 + 联动转待复核） |
| POST | `/api/corrections/:id/reject` | 审核退回（需 `reviewNote`） |

提交体示例：

```json
{
  "targetCollection": "puppetHeads",
  "targetId": "head-seed-1",
  "submittedBy": "档案员老周",
  "reason": "老戏单与箱底墨书不符",
  "changes": [
    { "field": "play", "newValue": "火焰山·新编", "evidence": "民国抄本戏单", "evidenceType": "戏单" },
    { "field": "boxNo", "newValue": "木箱甲-01", "evidence": "箱底墨书照片", "evidenceType": "照片" }
  ]
}
```

### 分层

- 接口入口：`server.js` 中的 `/api/corrections*` 路由，独立于通用 `/api/:collection` 入口；
- 审核规则：`lib/correctionService.js`（提交校验、退回、通过、联动转待复核）；
- 存储：`lib/correctionStore.js`（纠错单表、指纹去重、待审唯一性、联动收集）与 `lib/recordStore.js`（档案与履历）；
- 每张纠错单通过时，档案改值、履历追加、关联单据转待复核在同一 SQLite 事务内完成。

## 校验

```bash
npm run verify
```

对运行中的服务执行纠错单端到端规则校验（自动造数据，可重复运行）。
