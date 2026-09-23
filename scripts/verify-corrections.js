// 纠错单端到端校验：npm run verify（需服务已启动）
// 每次运行生成独立档案，可重复执行。
const BASE = process.env.BASE_URL || 'http://localhost:3914';
const run = Date.now().toString(36);

let failures = 0;
function check(name, cond, extra) {
  if (cond) {
    console.log('  ✓ ' + name);
  } else {
    failures += 1;
    console.log('  ✗ ' + name + (extra !== undefined ? ' → ' + JSON.stringify(extra) : ''));
  }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let data = null;
  try {
    data = await res.json();
  } catch (_) {}
  return { status: res.status, body: data };
}

async function main() {
  // ---------- 准备档案与单据 ----------
  const head = (
    await api('POST', '/api/puppetHeads', {
      role: '武生',
      play: '火焰山',
      paintStatus: '完好',
      mechanism: '正常',
      boxNo: '木箱丙-' + run,
      currentUsable: true
    })
  ).body;
  const acc = (
    await api('POST', '/api/accessories', {
      name: '红缨冠-' + run,
      role: '武生',
      play: '火焰山',
      boxNo: '配件箱-' + run
    })
  ).body;
  const openBox = (
    await api('POST', '/api/tourBoxes', {
      showName: '省城巡演',
      venue: '人民剧场',
      play: '火焰山',
      headIds: [head.id],
      accessoryIds: [acc.id]
    })
  ).body;
  const closedBox = (
    await api('POST', '/api/tourBoxes', {
      showName: '去年巡演',
      venue: '老戏台',
      play: '火焰山',
      headIds: [head.id],
      accessoryIds: [acc.id],
      status: '已闭环'
    })
  ).body;
  const lossOpen = (
    await api('POST', '/api/lossReports', {
      tourBoxId: openBox.id,
      itemType: '偶头',
      itemName: '武生偶头',
      problem: '掉彩'
    })
  ).body;
  const lossDone = (
    await api('POST', '/api/lossReports', {
      tourBoxId: openBox.id,
      itemType: '偶头',
      itemName: '武生偶头',
      problem: '已修好',
      status: '已补齐'
    })
  ).body;
  const lossAcc = (
    await api('POST', '/api/lossReports', {
      tourBoxId: closedBox.id,
      itemType: '配件',
      itemName: acc.name,
      problem: '缺珠'
    })
  ).body;

  console.log('1. 凭证缺失 → 退回');
  const noEvidence = { targetCollection: 'puppetHeads', targetId: head.id, changes: [{ field: 'play', newValue: '火焰山·新编' }] };
  let r = await api('POST', '/api/corrections', noEvidence);
  check('返回 422', r.status === 422, r.status);
  check('单据留档为已退回', r.body.status === '已退回', r.body.status);
  check('退回原因写明凭证缺失', /缺少来源凭证/.test(r.body.reviewNote || ''), r.body.reviewNote);
  const rejectedId = r.body.id;

  r = await api('POST', '/api/corrections', noEvidence);
  check('重复提交沿用首次结果（200 + reused）', r.status === 200 && r.body.reused === true, r.status);
  check('重复提交返回同一单号', r.body.id === rejectedId, r.body.id);

  console.log('2. 新值与当前档案相同 → 退回');
  r = await api('POST', '/api/corrections', {
    targetCollection: 'puppetHeads',
    targetId: head.id,
    changes: [{ field: 'role', newValue: '武生', evidence: '县志卷三' }]
  });
  check('返回 422 且已退回', r.status === 422 && r.body.status === '已退回', r.status);
  check('退回原因写明新旧相同', /新值与当前档案相同/.test(r.body.reviewNote || ''), r.body.reviewNote);

  console.log('3. 合法纠错单 → 待审');
  const valid = {
    targetCollection: 'puppetHeads',
    targetId: head.id,
    submittedBy: '档案员老周',
    reason: '老戏单与箱底墨书不符',
    changes: [
      { field: 'play', newValue: '火焰山·新编', evidence: '民国抄本戏单' },
      { field: 'boxNo', newValue: '木箱甲-' + run, evidence: '箱底墨书照片' }
    ]
  };
  r = await api('POST', '/api/corrections', valid);
  check('返回 201 待审', r.status === 201 && r.body.status === '待审', r.status);
  check('旧值已快照（play=火焰山）', r.body.changes.find((c) => c.field === 'play').oldValue === '火焰山');
  const corrId = r.body.id;

  console.log('4. 同一件只留一份待审');
  r = await api('POST', '/api/corrections', {
    targetCollection: 'puppetHeads',
    targetId: head.id,
    changes: [{ field: 'role', newValue: '武生（靠）', evidence: '戏单' }]
  });
  check('不同内容被冲突拒绝（409）', r.status === 409, r.status);
  check('冲突响应带已有单号', r.body.correctionId === corrId, r.body);

  r = await api('POST', '/api/corrections', valid);
  check('重复提交沿用首次结果', r.status === 200 && r.body.reused === true && r.body.id === corrId, r.status);

  r = await api('GET', '/api/corrections?status=待审&targetId=' + head.id);
  check('待审列表恰有一单', r.body.length === 1 && r.body[0].id === corrId, r.body.length);

  console.log('5. 审核通过 → 档案按新值显示，未结束单据转待复核');
  r = await api('POST', '/api/corrections/' + corrId + '/approve', { actor: '班主', reviewNote: '凭证核实无误' });
  check('通过返回 200', r.status === 200, r.body);
  check('两个字段均生效', (r.body.applied || []).length === 2, r.body.applied);
  check('联动转待复核含装箱单与缺损单', (r.body.impacted || []).length === 2, r.body.impacted);

  r = await api('GET', '/api/puppetHeads/' + head.id);
  check('当前档案按新值显示', r.body.play === '火焰山·新编' && r.body.boxNo === '木箱甲-' + run, r.body.play);
  check('档案状态未被改动', r.body.status === '可演出', r.body.status);

  r = await api('GET', '/api/tourBoxes/' + openBox.id);
  check('未结束装箱单转待复核', r.body.status === '待复核', r.body.status);
  r = await api('GET', '/api/tourBoxes/' + closedBox.id);
  check('已闭环装箱单不动', r.body.status === '已闭环', r.body.status);
  r = await api('GET', '/api/lossReports/' + lossOpen.id);
  check('未结束缺损单转待复核', r.body.status === '待复核', r.body.status);
  r = await api('GET', '/api/lossReports/' + lossDone.id);
  check('已补齐缺损单不动', r.body.status === '已补齐', r.body.status);

  console.log('6. 旧值继续可查');
  r = await api('GET', '/api/puppetHeads/' + head.id + '/timeline');
  const approveEvent = (r.body.events || []).find((e) => e.action === '档案纠错通过');
  check('履历留有纠错事件', !!approveEvent);
  check(
    '履历事件含旧值与新值',
    !!approveEvent &&
      approveEvent.data.applied.some((c) => c.field === 'play' && c.oldValue === '火焰山' && c.newValue === '火焰山·新编'),
    approveEvent && approveEvent.data.applied
  );
  r = await api('GET', '/api/corrections/' + corrId);
  check('纠错单详情含旧值快照', r.body.changes.find((c) => c.field === 'play').oldValue === '火焰山');
  check('纠错单详情显示当前新值', r.body.targetCurrent.fields.play === '火焰山·新编');

  console.log('7. 已通过的单不可再审；重复提交仍沿用首次结果');
  r = await api('POST', '/api/corrections/' + corrId + '/approve', { actor: '班主' });
  check('重复通过被拒（409）', r.status === 409, r.status);
  r = await api('POST', '/api/corrections', valid);
  check('通过后重复提交沿用首次结果', r.status === 200 && r.body.reused === true && r.body.status === '已通过', r.status);

  console.log('8. 审核退回需写明原因；退回后重复提交沿用退回结果');
  const toReject = {
    targetCollection: 'puppetHeads',
    targetId: head.id,
    changes: [{ field: 'role', newValue: '武生（靠）', evidence: '老戏单' }]
  };
  r = await api('POST', '/api/corrections', toReject);
  check('新内容可再立单（201）', r.status === 201, r.status);
  const corr2 = r.body.id;
  r = await api('POST', '/api/corrections/' + corr2 + '/reject', { actor: '班主' });
  check('缺退回原因被拒（400）', r.status === 400, r.status);
  r = await api('POST', '/api/corrections/' + corr2 + '/reject', { actor: '班主', reviewNote: '戏单年份存疑' });
  check('退回成功', r.status === 200 && r.body.correction.status === '已退回', r.status);
  r = await api('POST', '/api/corrections', toReject);
  check('退回后重复提交沿用退回结果', r.status === 200 && r.body.reused === true && r.body.status === '已退回', r.status);

  console.log('9. 配件纠错：按名称关联的缺损单同样转待复核');
  r = await api('POST', '/api/corrections', {
    targetCollection: 'accessories',
    targetId: acc.id,
    changes: [{ field: 'role', newValue: '武生（靠）', evidence: '行头簿' }]
  });
  check('配件纠错单待审', r.status === 201, r.status);
  const accCorr = r.body.id;
  r = await api('POST', '/api/corrections/' + accCorr + '/approve', { actor: '班主' });
  check('配件纠错通过', r.status === 200, r.body);
  r = await api('GET', '/api/lossReports/' + lossAcc.id);
  check('按名称匹配的缺损单转待复核', r.body.status === '待复核', r.body.status);

  console.log('10. 边界：目标不存在 / 字段不允许 / 未知单据');
  r = await api('POST', '/api/corrections', { targetCollection: 'puppetHeads', targetId: 'no-such', changes: [{ field: 'play', newValue: 'x', evidence: 'e' }] });
  check('目标不存在 404', r.status === 404, r.status);
  r = await api('POST', '/api/corrections', { targetCollection: 'puppetHeads', targetId: head.id, changes: [{ field: 'paintStatus', newValue: 'x', evidence: 'e' }] });
  check('非白名单字段 400', r.status === 400, r.status);
  r = await api('POST', '/api/corrections/nope/approve', { actor: 'a' });
  check('未知单据 404', r.status === 404, r.status);

  console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
