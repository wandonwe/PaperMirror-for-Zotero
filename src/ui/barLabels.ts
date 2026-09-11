/**
 * 工具栏标签的短形式 (2.10.0)。
 *
 * ## 为什么需要这个
 *
 * 语言胶囊里是「English → 简体中文」。窗格变窄时,`.pm-chip` 的
 * `flex: 0 1 auto` + `overflow: hidden` 会**把整个胶囊压扁**:实测 640px 时
 * 它只剩 **16px 宽**,屏幕上是一个字符,什么也读不出来。代码里早有一条注释
 * 记着上一次同样的教训 —— 当时两个胶囊各自截断成「Eng… → 简体…」,于是合并
 * 成了一个;合并解决了两次截断,没解决被压扁。
 *
 * 挤到不可读和干脆换一个短形式,是两件事。这里给的是后者:窄了就换
 * 「EN → 简」,始终是完整、可读的信息,而不是某个词被切掉一半。
 *
 * ## 规则
 *
 * - 拉丁/西里尔等字母文字:取前两个字母并大写(English → EN,Français → FR)。
 *   两个字母足以区分产品实际支持的那几种,一个字母不够(Deutsch / Dansk)。
 * - 汉字、假名、谚文:取**第一个字**(简体中文 → 简,繁體中文 → 繁,日本語 → 日)。
 *   这几种语言的区别恰好落在首字上,取两个字反而更宽。
 * - 本身就不超过两个字符的(自动、中文):原样返回,再缩就没有了。
 */

/** 表意/音节文字:汉字、假名、谚文、注音。这些语言取一个字就够认。 */
const IDEOGRAPHIC = /[぀-ヿ㄀-ㄯ㐀-䶿一-鿿豈-﫿가-힯]/;

/**
 * 把一个语言显示名压成 1–2 个字符的短形式。
 * 纯函数:同样的输入永远给同样的输出,不看 DOM、不看偏好。
 */
export function shortLangLabel(label: string): string {
	const text = label.trim();
	if (!text) {
		return '';
	}
	// [...text] 按码点切,不会把 emoji 或增补平面汉字劈成两半。
	const chars = [...text];
	if (chars.length <= 2) {
		return text;
	}
	if (IDEOGRAPHIC.test(chars[0]!)) {
		return chars[0]!;
	}
	return chars.slice(0, 2).join('').toUpperCase();
}
