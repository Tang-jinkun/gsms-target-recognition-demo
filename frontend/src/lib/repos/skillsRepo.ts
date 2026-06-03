import { loadSeeded, save, today } from '../localStore'

export type Skill = { id: string; name: string; desc: string; updated: string }
export type SkillFileNode = {
  name: string
  type: 'file' | 'dir'
  kind?: 'md' | 'code' | 'json' | 'bin'
  size?: string
  modified?: string
  children?: SkillFileNode[]
}
export type SkillContent =
  | { kind: 'md'; html: string }
  | { kind: 'code' | 'json'; code: string }
  | { kind: 'bin'; size: string }

const SKILLS_KEY = 'gsms.skills'
const DOCS_KEY = 'gsms.skillDocs'
const TREES_KEY = 'gsms.skillTrees'

const SEED: Skill[] = [
  { id: 'carbon', name: 'carbon-storage-skill', desc: '封装 InVEST 碳储量模型的输入准备、运行与结果汇总流程。', updated: '2024-03-15' },
  { id: 'habitat', name: 'habitat-quality-skill', desc: '生境质量评估：威胁因子配置、敏感度表校验与质量制图。', updated: '2024-03-09' },
  { id: 'wateryield', name: 'water-yield-skill', desc: '流域产水量分析，含降水/蒸散输入对齐与子流域汇总。', updated: '2024-02-27' },
  { id: 'raster', name: 'raster-align-skill', desc: '通用栅格预处理：重投影、对齐、重采样与裁剪到研究区。', updated: '2024-02-18' },
  { id: 'sdr', name: 'sediment-delivery-skill', desc: 'SDR 土壤保持模型：坡度与植被覆盖输入准备、泥沙输移比计算。', updated: '2024-02-10' },
  { id: 'ndr', name: 'nutrient-delivery-skill', desc: 'NDR 营养盐输移模型：面源氮磷负荷估算与入河贡献分析。', updated: '2024-02-03' },
  { id: 'pollination', name: 'pollination-skill', desc: '传粉服务评估：蜂群觅食与筑巢适宜性建模及作物产量贡献。', updated: '2024-01-26' },
  { id: 'vector', name: 'vector-prep-skill', desc: '矢量预处理：拓扑修复、字段标准化与研究区裁剪。', updated: '2024-01-18' },
  { id: 'report', name: 'report-export-skill', desc: '结果汇总导出：分区统计、图表生成与 PDF/CSV 报告打包。', updated: '2024-01-10' },
]

const CARBON_TREE: SkillFileNode[] = [
  { name: 'SKILL.md', type: 'file', kind: 'md', size: '4.2 KB', modified: '2024-03-15 15:40' },
  { name: 'README.md', type: 'file', kind: 'md', size: '1.1 KB', modified: '2024-03-10 11:02' },
  { name: 'scripts', type: 'dir', children: [
    { name: 'run_carbon.py', type: 'file', kind: 'code', size: '3.8 KB', modified: '2024-03-15 15:38' },
    { name: 'check_inputs.py', type: 'file', kind: 'code', size: '2.1 KB', modified: '2024-03-14 09:20' },
  ] },
  { name: 'config.json', type: 'file', kind: 'json', size: '820 B', modified: '2024-03-15 15:40' },
  { name: 'preview.png', type: 'file', kind: 'bin', size: '64 KB', modified: '2024-03-12 10:00' },
]

const DEFAULT_TREE: SkillFileNode[] = [
  { name: 'SKILL.md', type: 'file', kind: 'md', size: '3.0 KB', modified: '2024-03-09 10:00' },
  { name: 'scripts', type: 'dir', children: [{ name: 'run.py', type: 'file', kind: 'code', size: '2.4 KB', modified: '2024-03-09 10:00' }] },
]

export const CONTENT: Record<string, SkillContent> = {
  'SKILL.md': { kind: 'md', html: `
    <h1>carbon-storage-skill</h1>
    <p>封装 InVEST <code>Carbon Storage</code> 模型的标准作业流程：从项目资产中选取输入、校验、运行并汇总结果。该 Skill 供工作台 Agent 在用户手动触发时调用。</p>
    <h2>必需输入</h2>
    <ul>
      <li><code>landuse</code> — 土地利用栅格（GeoTIFF）</li>
      <li><code>carbon_pools</code> — 各地类碳密度表（CSV，t/ha）</li>
      <li><code>aoi</code> — 研究区边界（矢量）</li>
    </ul>
    <h2>输出</h2>
    <ul>
      <li><code>tot_c_cur.tif</code> — 总碳储量栅格</li>
      <li><code>carbon_summary.csv</code> — 分区汇总表</li>
    </ul>
    <h2>使用约定</h2>
    <p>运行前应执行 <code>check_inputs</code> 校验栅格对齐与碳密度表完整性；缺失类别将以警告形式提示，不阻断运行。</p>` },
  'README.md': { kind: 'md', html: `<h1>README</h1><p>本目录为 carbon-storage-skill 的资源包。入口说明见 <code>SKILL.md</code>。</p><h2>目录</h2><ul><li><code>scripts/</code> — 运行与校验脚本</li><li><code>config.json</code> — 默认参数</li></ul>` },
  'run_carbon.py': { kind: 'code', code: `<span class="c"># 运行 InVEST 碳储量模型</span>\n<span class="k">from</span> natcap.invest <span class="k">import</span> carbon\n\n<span class="k">def</span> run(args):\n    carbon.execute({\n        <span class="s">"lulc_cur_path"</span>: args[<span class="s">"landuse"</span>],\n        <span class="s">"carbon_pools_path"</span>: args[<span class="s">"carbon_pools"</span>],\n        <span class="s">"workspace_dir"</span>: args[<span class="s">"output_dir"</span>],\n    })\n    <span class="k">return</span> <span class="s">"tot_c_cur.tif"</span>` },
  'check_inputs.py': { kind: 'code', code: `<span class="c"># 校验输入完整性与栅格对齐</span>\n<span class="k">def</span> check(args):\n    issues = []\n    <span class="k">if</span> <span class="k">not</span> aligned(args[<span class="s">"landuse"</span>], args[<span class="s">"aoi"</span>]):\n        issues.append(<span class="s">"研究区与土地利用未对齐"</span>)\n    <span class="k">return</span> issues` },
  'config.json': { kind: 'json', code: `{\n  <span class="s">"model"</span>: <span class="s">"carbon_storage"</span>,\n  <span class="s">"default_output"</span>: <span class="s">"outputs/carbon_storage/"</span>,\n  <span class="s">"fill_missing"</span>: <span class="k">true</span>\n}` },
  'preview.png': { kind: 'bin', size: '64 KB' },
  'run.py': { kind: 'code', code: `<span class="c"># 模型运行入口</span>\n<span class="k">def</span> run(args):\n    <span class="k">pass</span>` },
}

function esc(s: string) {
  return (s || '').replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m] as string))
}
function makeDoc(s: Skill) {
  return `<h1>${esc(s.name)}</h1><p>${esc(s.desc) || '（暂无描述）'}</p>
    <h2>资源结构</h2><ul><li><code>SKILL.md</code> — 入口说明（本文件）</li><li><code>scripts/run.py</code> — 运行入口</li></ul>
    <h2>使用约定</h2><p>由工作台 Agent 在用户手动触发时调用；运行前请确认输入数据已对齐研究区。</p>`
}
function slugId(name: string) {
  return 'sk_' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) + '_' + Math.random().toString(36).slice(2, 6)
}

const readSkills = () => loadSeeded(SKILLS_KEY, SEED)
const readDocs = () => loadSeeded<Record<string, string>>(DOCS_KEY, {})
const readTrees = () => loadSeeded<Record<string, SkillFileNode[]>>(TREES_KEY, {})

export const skillsRepo = {
  list: () => readSkills(),
  get: (id: string) => readSkills().find(s => s.id === id),
  nameExists: (name: string, exceptId?: string) =>
    readSkills().some(s => s.name.toLowerCase() === name.toLowerCase() && s.id !== exceptId),
  treeFor(id: string): SkillFileNode[] {
    if (id === 'carbon') return CARBON_TREE
    const extra = readTrees()[id]
    if (extra) return extra
    return DEFAULT_TREE
  },
  contentFor(id: string, fileName: string): SkillContent | undefined {
    if (fileName === 'SKILL.md') {
      const doc = readDocs()[id]
      if (doc) return { kind: 'md', html: doc }
    }
    return CONTENT[fileName]
  },
  create(input: { name: string; desc: string }): Skill {
    const s: Skill = { id: slugId(input.name), name: input.name, desc: input.desc, updated: today() }
    save(SKILLS_KEY, [s, ...readSkills()])
    save(DOCS_KEY, { ...readDocs(), [s.id]: makeDoc(s) })
    save(TREES_KEY, { ...readTrees(), [s.id]: DEFAULT_TREE })
    return s
  },
  update(id: string, patch: { name: string; desc: string }): void {
    const list = readSkills().map(s => (s.id === id ? { ...s, ...patch, updated: today() } : s))
    save(SKILLS_KEY, list)
    const s = list.find(x => x.id === id)
    if (s) save(DOCS_KEY, { ...readDocs(), [id]: makeDoc(s) })
  },
  remove(id: string): void {
    save(SKILLS_KEY, readSkills().filter(s => s.id !== id))
    const docs = readDocs(); delete docs[id]; save(DOCS_KEY, docs)
    const trees = readTrees(); delete trees[id]; save(TREES_KEY, trees)
  },
}

export function flattenTree(nodes: SkillFileNode[]): SkillFileNode[] {
  let r: SkillFileNode[] = []
  nodes.forEach(n => { if (n.type === 'dir' && n.children) r = r.concat(flattenTree(n.children)); else r.push(n) })
  return r
}
