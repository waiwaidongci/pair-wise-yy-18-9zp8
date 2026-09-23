module.exports = {
  port: 3914,
  title: '传统木偶戏班偶头与巡演装箱API',
  description: '维护偶头、服装配件、修补流转、巡演装箱和返场缺损追踪。',
  collections: {
    puppetHeads: {
      label: '偶头档案',
      defaultStatus: '可演出',
      statuses: ['可演出', '待修补', '修补中', '试演中', '不可演出', '已装箱'],
      required: ['role', 'play', 'paintStatus', 'mechanism', 'boxNo'],
      titleFields: ['role', 'play'],
      defaults: { currentUsable: true }
    },
    accessories: {
      label: '服装配件',
      defaultStatus: '在库',
      statuses: ['在库', '已装箱', '缺损', '遗失'],
      required: ['name', 'role', 'play', 'boxNo'],
      titleFields: ['name', 'role']
    },
    repairRecords: {
      label: '修补记录',
      defaultStatus: '待处理',
      statuses: ['待处理', '补漆中', '换线中', '修机关中', '换眼珠中', '试演中', '已完成'],
      required: ['puppetHeadId', 'repairType', 'handler'],
      titleFields: ['repairType', 'handler']
    },
    tourBoxes: {
      defaultStatus: '草稿',
      statuses: ['草稿', '已装箱', '巡演中', '返场清点中', '待复核', '已闭环'],
      required: ['showName', 'venue', 'play', 'headIds', 'accessoryIds'],
      titleFields: ['showName', 'play']
    },
    lossReports: {
      label: '缺损追踪',
      defaultStatus: '待处理',
      statuses: ['待处理', '修复中', '待复核', '已补齐', '确认为遗失'],
      required: ['tourBoxId', 'itemType', 'itemName', 'problem'],
      titleFields: ['itemName', 'problem']
    }
  },
  // 纠错单配置：哪些档案的哪些字段允许纠错，以及通过后的联动
  corrections: {
    label: '档案纠错单',
    statuses: ['待审', '已通过', '已退回'],
    reviewStatus: '待复核',
    // 允许发起纠错的档案与字段
    targets: {
      puppetHeads: {
        fields: {
          play: { label: '剧目' },
          role: { label: '角色' },
          boxNo: { label: '箱号' }
        }
      },
      accessories: {
        fields: {
          play: { label: '剧目' },
          role: { label: '角色' },
          boxNo: { label: '箱号' }
        }
      }
    },
    // 尚未结束的单据：终态之外一律在纠错通过后转待复核
    unfinished: {
      tourBoxes: {
        terminal: ['已闭环'],
        refs: { headIds: 'puppetHeads', accessoryIds: 'accessories' }
      },
      lossReports: {
        terminal: ['已补齐', '确认为遗失'],
        via: { tourBoxId: 'tourBoxes' }
      }
    }
  },
  seed: [
    {
      collection: 'puppetHeads',
      id: 'head-seed-1',
      status: '待修补',
      data: {
        role: '武生',
        play: '火焰山',
        paintStatus: '左颊掉彩',
        mechanism: '开口机关偏紧',
        accessories: ['红缨冠', '短靠'],
        boxNo: '木箱乙-04',
        currentUsable: false
      },
      note: '返场发现掉彩'
    },
    {
      collection: 'accessories',
      id: 'accessory-seed-1',
      status: '在库',
      data: {
        name: '红缨冠',
        role: '武生',
        play: '火焰山',
        boxNo: '配件箱-02'
      }
    }
  ],
  examples: [
    'GET /api/puppetHeads?play=火焰山&status=可演出 查询某剧目可用偶头',
    'POST /api/tourBoxes 创建巡演装箱单',
    'POST /api/lossReports 登记返场缺损或遗失',
    'POST /api/corrections 提交档案纠错单（剧目/角色/箱号）',
    'POST /api/corrections/:id/approve 审核通过纠错单'
  ]
};
