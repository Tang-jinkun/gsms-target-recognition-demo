# GSMS Skills 管理页面说明

## 1. 页面名称

页面名称：Skills 管理  
英文名称：Skills  
所属系统：GSMS  
页面类型：本地 Skills 文件式管理页面

## 2. 页面定位

Skills 管理页面用于查看和管理 GSMS 本地已有的 Skills。

它主要回答两个问题：

```text
本地有哪些 Skills？
某个 Skill 里面有哪些文件，文件内容是什么？
```

这个页面不负责 Agent 对话，不负责 InVEST 模型运行，不负责 Skill 测试，也不负责复杂依赖管理。

它更接近一个面向 Skills 的轻量文件浏览器。

## 3. 页面层级

Skills 管理页面分为两个层级：

```text
第一层：Skills 列表页
第二层：Skill 详情页
```

第一层用于查看所有本地 Skills。  
第二层用于查看某个 Skill 的文件结构和文件详情。

## 4. 第一层：Skills 列表页

用户进入 Skills 页面后，首先看到 Skills 列表页。

它的作用是展示本地已有的 Skills。

基本布局如下：

```text
┌──────────────────────────────────────────────┐
│ GSMS 顶部系统导航栏                           │
│ 工作台 | 数据管理 | Skills | 设置 | 用户       │
├──────────────────────────────────────────────┤
│ Skills                                       │
│ 搜索框                         导入 Skill      │
├──────────────────────────────────────────────┤
│ Skills 列表                                   │
│                                              │
│ carbon-storage-skill                         │
│ 用于辅助 InVEST Carbon Storage 相关任务        │
│                                              │
│ habitat-quality-skill                        │
│ 用于辅助 InVEST Habitat Quality 相关任务       │
│                                              │
│ water-yield-skill                            │
│ 用于辅助 InVEST Water Yield 相关任务           │
└──────────────────────────────────────────────┘
```

## 5. 顶部系统导航

页面顶部为 GSMS 系统级导航栏。

导航栏包含：

```text
GSMS
工作台
数据管理
Skills
设置
用户入口
```

当前页面为 Skills 页面，因此顶部导航中的 “Skills” 处于选中状态。

顶部系统导航只负责页面切换，不承载 Skills 的具体文件操作。

## 6. Skills 列表页内容

Skills 列表页主要包含：

```text
页面标题
搜索框
导入 Skill 按钮
Skills 列表
```

页面标题为：

```text
Skills
```

搜索框用于按 Skill 名称搜索本地 Skills。

导入 Skill 用于导入新的本地 Skill，例如从本地目录或压缩包导入。

Skills 列表展示每个 Skill 的基础信息。

每个 Skill 条目建议包含：

```text
Skill 名称
一句话描述
更新时间
```

例如：

```text
carbon-storage-skill
用于辅助 InVEST Carbon Storage 相关任务
更新于 2024-05-20
```

用户点击某个 Skill 条目后，进入该 Skill 的详情页。

## 7. 第二层：Skill 详情页

用户点击某个 Skill 后，进入 Skill 详情页。

Skill 详情页顶部显示面包屑，用于告诉用户当前所在位置，并支持返回 Skills 列表。

面包屑示例：

```text
Skills / carbon-storage-skill
```

其中 “Skills” 可点击返回列表页。

Skill 详情页主体采用两栏结构：

```text
左侧：文件结构
右侧：文件详情
```

基本布局如下：

```text
┌──────────────────────────────────────────────┐
│ GSMS 顶部系统导航栏                           │
│ 工作台 | 数据管理 | Skills | 设置 | 用户       │
├──────────────────────────────────────────────┤
│ Skills / carbon-storage-skill                │
├────────────────────┬─────────────────────────┤
│ 文件结构             │ 文件详情                 │
│ File Tree          │ File Detail              │
│                    │                         │
│ carbon-storage     │ 文件名称：SKILL.md        │
│ ├── SKILL.md        │ 文件类型：Markdown        │
│ ├── README.md       │ 路径：.../SKILL.md        │
│ ├── scripts         │ 修改时间：2024-05-20      │
│ │   └── run.py      │                         │
│ ├── examples        │ 文档内容：                │
│ │   └── sample.json │ # Carbon Storage Skill   │
│ └── requirements.txt│ ...                     │
└────────────────────┴─────────────────────────┘
```

## 8. Skill 详情页核心关系

Skill 详情页的核心关系是：

```text
文件结构 → 文件详情
```

用户先在左侧文件结构中选择某个文件，然后右侧显示该文件详情。

## 9. 左侧：文件结构

左侧文件结构用于展示当前 Skill 的目录和文件。

例如：

```text
carbon-storage-skill
├── SKILL.md
├── README.md
├── scripts
│   ├── preprocess.py
│   └── run.py
├── examples
│   └── sample_input.json
└── requirements.txt
```

文件结构需要支持：

```text
展开文件夹
折叠文件夹
选择文件
```

当前阶段不需要支持复杂文件编辑，也不需要支持拖拽移动文件。

## 10. 右侧：文件详情

右侧文件详情用于展示当前选中文件的信息和内容。

它可以包含：

```text
文件名称
文件类型
文件路径
文件大小
修改时间
文件内容
```

例如选中 `SKILL.md` 后：

```text
文件名称：SKILL.md
文件类型：Markdown
文件路径：carbon-storage-skill/SKILL.md
文件大小：12KB
修改时间：2024-05-20

文件内容：
# Carbon Storage Skill

...
```

如果选中的是 Markdown 文件，应以 Markdown 方式渲染内容。

如果选中的是代码文件，可以以只读代码块方式展示内容。

如果选中的是 JSON、TXT 等文本文件，可以以只读文本形式展示内容。

如果选中的是无法预览的二进制文件，则只展示文件基本信息，并提示：

```text
该文件暂不支持内容预览
```

## 11. 默认展示规则

进入某个 Skill 详情页后，默认选中 `SKILL.md`。

如果该 Skill 没有 `SKILL.md`，则默认选中 `README.md`。

如果两者都不存在，则右侧显示空状态：

```text
请选择一个文件查看详情
```

## 12. 搜索与导入

Skills 列表页提供搜索能力。

搜索范围为：

```text
Skill 名称
Skill 简短描述
```

搜索不检索 Skill 内部文件全文内容。

导入 Skill 用于添加新的本地 Skill。

导入后，Skills 列表刷新，并显示新增 Skill。

## 13. 页面边界

Skills 管理页面只负责本地 Skills 的查看和基础导入。

它不负责：

```text
Agent 对话
InVEST 模型运行
Skill 测试
依赖安装
复杂文件编辑
在线 Skills 市场
地图展示
数据文件管理
模型供应商配置
```

这些功能应分别放在其他页面：

```text
Agent 对话、模型运行、地图展示 → 智能工作台
数据文件管理 → 数据管理页面
模型供应商配置和用户设置 → 设置页面
```

## 14. 设计原则

Skills 管理页面应保持轻量、清晰、文件式。

设计上强调：

```text
第一层只看 Skills 列表；
第二层只看文件结构和文件详情；
面包屑表达当前位置；
不加入测试区；
不加入依赖状态；
不加入复杂能力编排；
不做插件市场风格。
```

## 15. 总结

GSMS Skills 管理页面采用两层结构：

```text
Skills 列表
→ Skill 详情
```

Skill 详情页采用两栏结构：

```text
文件结构
→ 文件详情
```

用户先在列表中选择一个 Skill，再进入详情页查看该 Skill 的文件结构和具体文件内容。

这个页面的核心是克制地管理本地 Skills，而不是运行、测试或编排 Skills。