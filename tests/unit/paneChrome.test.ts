/**
 * 窗格外壳的结构性回归闸 (2.10.0)。
 *
 * 这一版改的是界面,而界面最容易「改好了又被悄悄改回去」——
 * 尤其是特指度和 `scroll-behavior` 这两件事:它们不报错、不掉测试,
 * 只是让某些声明静静地不生效。所以这里盯的不是像素,是**那几条容易复发的性质**。
 *
 * 取证方式说明:2.10.0 的现状审查是用真实 CSS + 真实 DOM 在 headless
 * Chromium 里量的(preview/),那套不进 CI —— 它需要浏览器。
 * 这个文件只做源码层面的结构断言,任何环境都能跑。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shortLangLabel } from '../../src/ui/barLabels';

const read = (p: string): string => readFileSync(join(process.cwd(), p), 'utf8');
const CSS = (): string => read('src/ui/styles/translationPane.css');
const PANE = (): string => read('src/ui/translationPane.ts');

/**
 * 去掉注释再做结构断言。
 *
 * 变异验证里有两条一开始**存活**,原因都一样:断言匹配到了**自己上面那段注释**。
 * 注释里写着 "aria-checked 必须跟着走",于是把那行代码删掉,断言照样为真。
 * 这个项目里的结构闸盯的是代码,不是描述代码的话。
 */
const code = (src: string): string =>
	src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// ---- 1. 按钮重置不许再压过组件类 -------------------------------------------
//
// 真实测量(2.9.9 的样式表):`.pm-bilingual-pane button` 是 0,1,1,
// 压过 `.pm-bar-action` / `.pm-chip` / `.pm-icon-button` 等 0,1,0 的单类名规则,
// 于是 6 个类、9 条着色声明一条都没生效,工具栏塌成同一个正文色。

test('按钮重置用 :where() 降到零特指度 (2.10.0)', () => {
	const css = CSS();
	assert.ok(/:where\(\.pm-bilingual-pane\)\s+button\s*\{/.test(css),
		'重置必须包在 :where() 里 —— 否则类型选择器又会压过组件类');
	assert.ok(!/^\.pm-bilingual-pane\s+button\s*\{/m.test(css),
		'不许再出现裸的 `.pm-bilingual-pane button` —— 那正是把层级压平的那一条');
});

test('工具栏动作按钮有真实的 hover 反馈 (2.10.0)', () => {
	const css = CSS();
	const hover = css.slice(css.indexOf('.pm-bar-action:hover'), css.indexOf('}', css.indexOf('.pm-bar-action:hover')));
	// 旧写法是 `filter: brightness(1.08)` —— 作用在透明背景上,实测 hover 前后
	// backgroundColor 与 color 完全不变,等于没有反馈。
	assert.ok(/background\s*:/.test(hover),
		'hover 必须改变背景 —— brightness() 在透明背景上什么也不做');
	assert.ok(!/filter\s*:\s*brightness/.test(hover));
});

test('破坏性动作与普通阅读动作在视觉上分开 (2.10.0)', () => {
	const css = CSS();
	assert.ok(/\.pm-refresh:hover[\s\S]{0,120}var\(--pm-error\)/.test(css),
		'「全文重译」会丢弃已翻译内容并产生费用,手停上去时必须与设置/关闭区分');
});

// ---- 2. 焦点可见 -------------------------------------------------------------

test('有焦点环,且只在键盘路径亮起 (2.10.0)', () => {
	const css = CSS();
	assert.ok(/:focus-visible/.test(css), '整张表此前 0 条 focus 规则');
	assert.ok(/outline\s*:\s*2px solid var\(--pm-accent\)/.test(css));
	// box-shadow 会被祖先的 overflow: hidden 裁掉,outline 不会;
	// 而且 outline 不参与布局,不会挪动任何几何。
	//
	// 锚点必须落在**规则**上,不能落在第一处文字出现的地方 —— 上面那段注释里
	// 就写着 "box-shadow" 四个字,按文字切会切到注释,断言于是永远为假。
	const at = css.indexOf(':where(.pm-bilingual-pane) :is(');
	assert.ok(at > 0, '焦点环规则本身要在');
	const ring = css.slice(at, css.indexOf('}', at));
	assert.ok(!/box-shadow/.test(ring), '焦点环用 outline,不用 box-shadow');
});

// ---- 3. 同步开关必须能用键盘操作 ---------------------------------------------
//
// 实测 2.9.9:`<span role="switch">`,tabIndex = -1、aria-checked = null。
// 键盘完全够不到,屏幕阅读器也读不出开关状态。

test('同步开关可聚焦、可键盘切换、状态可播报 (2.10.0)', () => {
	const src = PANE();
	const fn = code(src.slice(src.indexOf('private switchControl('), src.indexOf('\n\t}', src.indexOf('private switchControl('))));
	assert.ok(/setAttribute\('tabindex', '0'\)/.test(fn), '不可聚焦就等于键盘够不到');
	// 建立时就要有,不能等到第一次切换才补 —— 否则刚打开的窗格上,
	// 屏幕阅读器读到的是一个没有状态的 switch。
	assert.ok(/setAttribute\('aria-checked', String\(initial\)\)/.test(fn),
		'role="switch" 缺 aria-checked 是无效的,而且初始值就得有');
	assert.ok(/setAttribute\('aria-checked', String\(next\)\)/.test(fn),
		'切换时也要更新,否则第一次之后就对不上了');
	assert.ok(/addEventListener\('keydown'/.test(fn), 'Enter / Space 必须能切换');
	assert.ok(/preventDefault\(\)/.test(fn),
		'空格在滚动容器里默认翻页 —— 不吃掉它,按一次开关阅读位置就跳一页');
});

test('外部改同步状态时 aria-checked 跟着走 (2.10.0)', () => {
	const src = PANE();
	const fn = code(src.slice(src.indexOf('setSyncEnabled('), src.indexOf('\n\t}', src.indexOf('setSyncEnabled('))));
	assert.ok(/setAttribute\('aria-checked', String\(enabled\)\)/.test(fn),
		'只更新 data-pm-on 的话,屏幕阅读器读到的是上一次的值 —— 比没有更糟');
});

// ---- 4. 阅读区默认不平滑滚动 -------------------------------------------------

test('.pm-scroll 默认瞬时滚动 (2.10.0)', () => {
	const css = CSS();
	const block = css.slice(css.indexOf('.pm-scroll {'), css.indexOf('}', css.indexOf('.pm-scroll {')));
	assert.ok(/scroll-behavior\s*:\s*auto/.test(block),
		'连续跟随每帧写一次 scrollTop;默认平滑就会帧帧打断,右侧永远追不上');
	assert.ok(!/scroll-behavior\s*:\s*smooth/.test(block));
});

test('瞬时写入这道防线还在 (2.9.8 起)', () => {
	const src = PANE();
	assert.ok(/private scrollInstantly\(top: number\)/.test(src));
	const fn = src.slice(src.indexOf('setPdfScrollFraction(pageIndex: number'), src.indexOf('\n\t}', src.indexOf('setPdfScrollFraction(pageIndex: number')));
	assert.ok(/this\.scrollInstantly\(/.test(fn),
		'CSS 默认值改了不等于可以拆掉这层 —— 它防的是行内 style 覆盖');
});

test('尊重「减少动态效果」(2.10.0)', () => {
	assert.ok(/@media \(prefers-reduced-motion: reduce\)/.test(CSS()));
});

// ---- 5. 窄窗格:收纳而不是挤扁或裁掉 -----------------------------------------
//
// 实测 2.9.9:640px 时语言胶囊被压到 **16px**(一个字符);
// 390px(窗格自己声明的 min-width)时工具栏溢出 **146px**,
// 「更多 / 左右 / 设置 / 关闭」四个控件被 overflow:hidden 直接切掉、点不到。

test('胶囊不许再被压扁 (2.10.0)', () => {
	const css = CSS();
	const chip = css.slice(css.indexOf('.pm-chip {'), css.indexOf('}', css.indexOf('.pm-chip {')));
	assert.ok(/flex\s*:\s*0 0 auto/.test(chip),
		'flex-shrink 一旦大于 0,窄窗格就会把整个胶囊挤成一个字符');
	assert.ok(!/overflow\s*:\s*hidden/.test(chip),
		'不挤了就不需要靠 overflow 藏截断 —— 留着只会掩盖下一次回归');
	const lang = css.slice(css.indexOf('.pm-chip-lang {'), css.indexOf('}', css.indexOf('.pm-chip-lang {')));
	assert.ok(/flex-shrink\s*:\s*0/.test(lang), '原为 flex-shrink: 3 —— 它第一个被压塌');
});

test('窄档换短形式,不是切一半 (2.10.0)', () => {
	const css = CSS();
	assert.ok(/\.pm-lang-short\s*\{[\s\S]{0,60}display\s*:\s*none/.test(css), '默认显示全名');
	assert.ok(/@media \(max-width: 760px\)[\s\S]{0,300}\.pm-lang-short/.test(css));
	const src = PANE();
	const fn = src.slice(src.indexOf('setLanguagePair('), src.indexOf('\n\t}', src.indexOf('setLanguagePair(')));
	assert.ok(/'pm-lang-full'/.test(fn) && /'pm-lang-short'/.test(fn),
		'两份都要在 DOM 里 —— 切换只是 display,不触发重新测量');
	assert.ok(/aria-label/.test(fn),
		'短形式顶替时可读名不能跟着丢');
});

test('操作按语义分组,低频的进「更多」(2.10.2)', () => {
	const src = PANE();
	const build = src.slice(src.indexOf('private build(): void'), src.indexOf('// --- scroll body'));
	const more = src.slice(src.indexOf('private buildMoreButton()'), src.indexOf('\n\t}', src.indexOf('private buildMoreButton()')));

	// 「保存到笔记」低频,留在菜单里。
	assert.ok(!/onSaveNote\(\)\)/.test(build), '「保存到笔记」应在「更多」里');
	assert.ok(/onSaveNote\(\)/.test(more), '下沉不是删掉 —— 动作必须仍然可达');

	// 「术语」2.10.2 回到常驻,与「解析」并列;不许在菜单里重复出现 ——
	// 同一个动作两个入口,菜单会越长越像杂物抽屉。
	assert.ok(/termsButton/.test(build), '「术语」应常驻工具条');
	assert.ok(!/onSaveTerms\(\)/.test(more), '常驻之后不该在菜单里重复');

	for (const keep of ['this.languagePill', 'providerPill', 'refreshChip', 'this.syncSwitch', 'explainButton', 'termsButton']) {
		assert.ok(build.includes(keep), `${keep} 必须常驻`);
	}
});

test('同步滚动归入左组,排在全文重译之后 (2.10.2)', () => {
	const src = PANE();
	const append = src.slice(src.indexOf('bar.append('), src.indexOf(');', src.indexOf('bar.append(')));
	const at = (needle: string): number => append.indexOf(needle);
	// 它是**状态**(两边是不是跟着走),不是动作 —— 和右边那排
	// 「对选中内容做什么」不是一类,不该被弹性空隙隔到右边去。
	assert.ok(at('refreshChip') < at('this.syncSwitch'), '同步滚动排在全文重译之后');
	assert.ok(at('this.syncSwitch') < at("'pm-bar-spacer'"), '同步滚动在弹性空隙之前,属于左组');
	assert.ok(at("'pm-bar-spacer'") < at('explainButton'), '动作在弹性空隙之后,属于右组');
	assert.ok(at('explainButton') < at('termsButton'), '术语紧跟解析');
	assert.ok(at('termsButton') < at('this.buildMoreButton()'), '「更多」在动作之后收尾');
});

test('文字动作按钮同一套图标与收纳规则 (2.10.2, 3.0.2 三个)', () => {
	const src = PANE();
	assert.ok(/terms: 'M4 19\.5V5/.test(src), '「术语」要有自己的线条图标');
	// 各写一份构造迟早会在 aria-label、图标尺寸或标签包裹上分叉。
	// 只数构造函数出现几次是不够的 —— 旁边再写一个别的名字,计数照样是 1。
	// 要钉的是**两个按钮都从它出来**。
	const body = code(src);
	// 3.0.2: 视图切换按钮也从这里出来 —— 三个,不多不少。
	for (const name of ['viewKindButton', 'explainButton', 'termsButton']) {
		assert.ok(new RegExp(`const ${name} = actionButton\\(`).test(body),
			`${name} 必须由共用构造产出`);
	}
	assert.equal((body.match(/= actionButton\(/g) ?? []).length, 3,
		'共用构造正好产出这三个按钮');
	const css = CSS();
	assert.ok(/\.pm-bar-action svg \{/.test(css), '图标样式对所有动作按钮生效,不是某一个专属');
	const narrow = css.slice(css.indexOf('@media (max-width: 640px)'));
	assert.ok(/\.pm-bar-action-view span,\s*\n\s*\.pm-bar-action-explain span,\s*\n\s*\.pm-bar-action-terms span/.test(narrow),
		'窄档三个按钮一起收成纯图标 —— 只收一个,另一个照样把控件挤出去');
});

test('表头不换行 —— 页面起点不跳靠的就是它 (2.10.0 守住既有性质)', () => {
	const css = CSS();
	const header = css.slice(css.indexOf('.pm-header {\n\tdisplay: flex'));
	assert.ok(/flex-wrap\s*:\s*nowrap/.test(header.slice(0, 300)),
		'一旦允许换行,表头高度会随宽度变化,而页偏移的基准里含着表头');
});

test('最窄档靠收紧间距腾地方,不靠再藏控件 (2.10.2)', () => {
	const css = CSS();
	// 「术语」回到常驻后多占约 28px,390px 下工具栏又溢出 24px、裁掉一个控件。
	// 省 gap 与内边距约 32px 够用,且不损失任何信息 —— 服务标记是"当前用哪个
	// 引擎"的唯一显示,图标按钮 28px 也已接近可点下限,两者都不该再动。
	// 文件里有**两个** `@media (max-width: 430px)`(另一处管 .pm-scroll 的内边距),
	// 按第一处文字出现切会切到错的那个 —— 取包含 `.pm-bar {` 的那一块。
	const blocks = [...css.matchAll(/@media \(max-width: 430px\) \{([\s\S]*?)\n\}/g)]
		.map(m => m[1]!);
	const tier = blocks.find(b => /\.pm-bar \{/.test(b));
	assert.ok(tier, '最窄档必须有一块管工具条');
	assert.ok(/\.pm-bar \{[\s\S]{0,80}gap: 2px/.test(tier!), '最窄档收紧 gap');
	assert.ok(/\.pm-bar-sep \{[\s\S]{0,60}margin: 0 2px/.test(tier!), '分隔线也跟着收');
	assert.ok(!/display\s*:\s*none/.test(tier!),
		'这一档不许再藏控件 —— 藏的是信息,收的是空白');
});

test('表头只定义一处 (2.10.0)', () => {
	const css = CSS();
	// 合并前 `.pm-header` 在文件里出现 **5 次**(顶层 3 次 + 两个 430px 媒体查询各 1 次),
	// 后面的覆盖前面的,只有最后一条算数。更糟的是:合并时如果照搬那两条媒体查询里的
	// padding,它们会**活过来** —— 实测 430px 以下表头从 41px 涨到 49px、
	// 阅读区起点跟着下移 8px。多一份定义就多一次这样的事故。
	const tops = (css.match(/^\.pm-header \{/gm) ?? []).length;
	assert.equal(tops, 1, '.pm-header 只能有一处顶层定义');
	assert.ok(!/@media[^{]*\{[\s\S]*?\.pm-header\s*\{[^}]*padding/.test(css),
		'媒体查询里不许再改表头 padding —— 表头高度是同步落点的基准');
});

// ---- 6. 短标签是纯函数,单独可测 ---------------------------------------------

test('短语言标签:字母文字取两位并大写', () => {
	assert.equal(shortLangLabel('English'), 'EN');
	assert.equal(shortLangLabel('Français'), 'FR');
	assert.equal(shortLangLabel('Deutsch'), 'DE');
	assert.equal(shortLangLabel('Español'), 'ES');
	// 一位不够:Deutsch 和 Dansk 都会变成 D。
	assert.notEqual(shortLangLabel('Deutsch'), shortLangLabel('Dansk'));
});

test('短语言标签:汉字/假名/谚文取首字', () => {
	assert.equal(shortLangLabel('简体中文'), '简');
	assert.equal(shortLangLabel('繁體中文'), '繁');
	assert.equal(shortLangLabel('日本語'), '日');
	assert.equal(shortLangLabel('한국어'), '한');
	// 简繁必须分得开 —— 这正是用户最常切的一对。
	assert.notEqual(shortLangLabel('简体中文'), shortLangLabel('繁體中文'));
});

test('短语言标签:本来就短的原样返回,空串不炸', () => {
	assert.equal(shortLangLabel('自动'), '自动');
	assert.equal(shortLangLabel('中文'), '中文');
	assert.equal(shortLangLabel(''), '');
	assert.equal(shortLangLabel('   '), '');
});

// ---- 7. 文案:不许再有写死的简体中文 -----------------------------------------

test('工具栏文案走语言包,不写死在源码里 (2.10.0)', () => {
	const src = PANE();
	// 这几条原先直接写在 translationPane.ts 里,en-US / zh-TW 用户也看到简体。
	for (const literal of ['\'切换语言\'', '\'切换翻译服务\'', '\'术语\'', '\'全文重译(丢失已翻译内容)\'', '\'配置翻译服务 →\'']) {
		assert.ok(!src.includes(literal), `${literal} 应改为 this.strings.* 并进语言包`);
	}
});

test('三个语言包与兜底表条目齐全 (2.10.0)', () => {
	const keys = [
		'papermirror-switch-language', 'papermirror-switch-provider',
		'papermirror-terms', 'papermirror-terms-tip', 'papermirror-more',
		'papermirror-configure-provider', 'papermirror-configure-provider-tip'
	];
	for (const loc of ['zh-CN', 'zh-TW', 'en-US']) {
		const ftl = read(`locale/${loc}/papermirror.ftl`);
		for (const k of keys) {
			assert.ok(new RegExp(`^${k} = \\S`, 'm').test(ftl), `${loc} 缺 ${k}`);
		}
	}
	const fallback = read('src/utils/l10n.ts');
	for (const k of keys) {
		assert.ok(fallback.includes(`'${k}'`), `兜底表缺 ${k}`);
	}
});

test('破坏性动作的标签说清后果 (2.10.0)', () => {
	// 「重新翻译」四个字看不出它会丢弃全文已翻译的内容。
	for (const loc of ['zh-CN', 'zh-TW']) {
		const line = /papermirror-retranslate = (.+)/.exec(read(`locale/${loc}/papermirror.ftl`))![1]!;
		assert.ok(/丢弃|捨棄/.test(line), `${loc} 的标签必须说明会丢弃已翻译内容`);
	}
	assert.ok(/discards/.test(/papermirror-retranslate = (.+)/.exec(read('locale/en-US/papermirror.ftl'))![1]!));
});

test('没有无人消费的死字符串 (2.10.0)', () => {
	// papermirror-sync-on / sync-off 在三个语言包和兜底表里都有,却没有任何
	// 代码读它们 —— 而窗格用的是 papermirror-prefs-syncscroll。
	const consumers = PANE() + read('src/reader/readerSession.ts') + read('src/reader/readerToolbar.ts');
	for (const loc of ['zh-CN', 'zh-TW', 'en-US']) {
		const ftl = read(`locale/${loc}/papermirror.ftl`);
		assert.ok(!/^papermirror-sync-(on|off) =/m.test(ftl), `${loc} 仍留着死字符串`);
	}
	assert.ok(!consumers.includes('papermirror-sync-on'));
});

// ---- 8. 主题要跟着宿主变 -----------------------------------------------------

test('主题变化有订阅,且会被拆除 (2.10.0)', () => {
	const adapter = read('src/reader/zoteroReaderAdapter.ts');
	assert.ok(/export function watchTheme\(/.test(adapter));
	assert.ok(/addEventListener\('change'/.test(adapter.slice(adapter.indexOf('export function watchTheme('))));
	const session = read('src/reader/readerSession.ts');
	assert.ok(/this\.disposeTheme = adapter\.watchTheme\(/.test(session),
		'此前主题只在建窗格时读一次 —— 开着窗格切主题,窗格是唯一不变的那块');
	assert.ok(/this\.disposeTheme\?\.\(\);/.test(session), '订阅必须在关闭时解掉,否则是泄漏');
});

// ---- 9. 文章流视图必须有入口、有出口、有内容 (3.0.2) -------------------------
//
// 真机截图(Goenka 2016,3.0.1):点胶囊「查看译文」→ 右侧整片空白,且回不去。
// 两个原因叠在一起:`viewKindButton` 自 1b62d31 起只声明从未创建(没有出口);
// `pane.setViewKind('article')` 清空一切后**等** renderPage,而没人再送(没有内容)。

test('视图切换按钮真的被创建,并接到 onToggleViewKind (3.0.2)', () => {
	const pane = code(PANE());
	assert.ok(/this\.viewKindButton = /.test(pane),
		'viewKindButton 只声明不创建 —— 文章流视图在界面上就没有出口');
	assert.ok(/onToggleViewKind\(this\.viewKind === 'page' \? 'article' : 'page'\)/.test(pane),
		'按钮必须切到**另一个**视图');
	// 「更多」菜单里也要有两项带勾选 —— 窄窗会把工具条按钮裁掉。
	assert.ok(/checked: this\.viewKind === 'page'/.test(pane) && /checked: this\.viewKind === 'article'/.test(pane));
	// 窄档收标签的规则要覆盖这个按钮,否则它一个就把工具条撑爆。
	const css = CSS();
	assert.ok(/\.pm-bar-action-view span,[\s\S]{0,80}display: none;/.test(css));
});

test('切到文章流要把已有页面状态重新喂给面板,而不是留一片空白 (3.0.2)', () => {
	const session = code(read('src/reader/readerSession.ts'));
	// 偏好回调不能只写偏好 —— 3.0.1 之前 onToggleViewKind 只 setPref,视图本身不动。
	assert.ok(/onToggleViewKind: kind => this\.applyPaneViewKind\(kind, \{ persist: true \}\)/.test(session));
	const at = session.indexOf('private applyPaneViewKind(');
	assert.ok(at > 0);
	const body = session.slice(at, session.indexOf('\n\t}\n', at));
	assert.ok(/this\.pane\.setViewKind\(kind\)/.test(body));
	assert.ok(/getPageState\(p\)/.test(body) && /this\.pane\.renderPage\(state\)/.test(body),
		'必须把每页已有状态 renderPage 回去 —— setViewKind 清空文章流后没人再送');
	assert.ok(/this\.pane\.scrollToPage\(target\)/.test(body));
	// 「查看译文」走同一条路,且不改用户的默认视图偏好。
	const kept = session.slice(session.indexOf('private viewKeptOriginal('), session.indexOf('private applyPaneViewKind('));
	assert.ok(/this\.applyPaneViewKind\('article', \{ persist: false, pageIndex \}\)/.test(kept));
	assert.ok(!/this\.pane\.setViewKind\('article'\)/.test(kept), 'viewKeptOriginal 不许绕过重喂直接 setViewKind');
});
