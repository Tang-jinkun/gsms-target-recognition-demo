import { loadSeeded, save, today } from '../localStore'

export type Scene = {
  id: string
  name: string
  desc: string
  region: string
  note: string
  updated: string
}

const KEY = 'gsms.scenes'

/** Seed mirrors open_design/scenes.html. */
const SEED: Scene[] = [
  { id: 'sc_nanjing', name: '南京市碳储量评估', desc: '基于土地利用与 InVEST Carbon Storage 模型评估研究区碳储量与固碳分布。', region: '南京市', note: '2020 基准年', updated: '2024-05-20' },
  { id: 'sc_yangtze', name: '长江中游湿地碳汇评估', desc: '湿地土地利用变化下的碳汇能力分析，含多情景对比。', region: '长江中游', note: '', updated: '2024-05-12' },
  { id: 'sc_changsanjiao', name: '长三角生境质量分析', desc: '基于威胁因子与敏感度表评估城市群扩张对生境质量的影响。', region: '长三角城市群', note: '', updated: '2024-04-28' },
  { id: 'sc_zhujiang', name: '珠江三角洲产水量分析', desc: '流域尺度产水量与水源涵养评估，对齐降水与蒸散输入并按子流域汇总。', region: '珠江三角洲', note: '', updated: '2024-04-22' },
  { id: 'sc_qinghai', name: '青海湖流域水源涵养', desc: '高寒湿地与草地覆盖变化下的水源涵养服务评估。', region: '青海湖流域', note: '多年平均', updated: '2024-04-15' },
  { id: 'sc_huanghe', name: '黄河三角洲土壤保持', desc: 'InVEST SDR 模型评估植被覆盖对土壤侵蚀与泥沙输移的削减作用。', region: '黄河三角洲', note: '', updated: '2024-04-06' },
  { id: 'sc_hainan', name: '海南岛红树林固碳评估', desc: '滨海红树林分布与碳密度调查，估算蓝碳储量及其时空变化。', region: '海南岛', note: '试点', updated: '2024-03-29' },
  { id: 'sc_chengdu', name: '成都平原城市热岛分析', desc: '不透水面扩张与地表温度关系分析，识别热环境高风险片区。', region: '成都平原', note: '', updated: '2024-03-21' },
  { id: 'sc_taihu', name: '太湖流域营养盐输移', desc: 'NDR 模型评估面源氮磷负荷的空间分布与入湖贡献。', region: '太湖流域', note: '', updated: '2024-03-12' },
]

function read(): Scene[] {
  return loadSeeded(KEY, SEED)
}

export const scenesRepo = {
  list(): Scene[] {
    return read()
  },
  get(id: string): Scene | undefined {
    return read().find(s => s.id === id)
  },
  create(input: Omit<Scene, 'id' | 'updated'>): Scene {
    const list = read()
    const scene: Scene = { ...input, id: 'sc_' + Math.random().toString(36).slice(2, 8), updated: today() }
    save(KEY, [scene, ...list])
    return scene
  },
  update(id: string, patch: Partial<Omit<Scene, 'id'>>): void {
    const list = read().map(s => (s.id === id ? { ...s, ...patch, updated: today() } : s))
    save(KEY, list)
  },
  remove(id: string): void {
    save(KEY, read().filter(s => s.id !== id))
  },
  nameExists(name: string, exceptId?: string): boolean {
    return read().some(s => s.name.toLowerCase() === name.toLowerCase() && s.id !== exceptId)
  },
}
