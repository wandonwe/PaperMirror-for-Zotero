/** Chinese script labels and uppercase language abbreviations for the narrow toolbar. */
const LABELS: Record<string,string> = {
 'en':'EN', 'english':'EN', 'zh':'ZH', '中文':'ZH',
 'zh-cn':'简', '简体中文':'简', 'zh-tw':'繁', '繁體中文':'繁', '繁体中文':'繁',
 'ja':'JA', '日本語':'JA', 'ko':'KO', '한국어':'KO',
 'de':'DE', 'deutsch':'DE', 'fr':'FR', 'français':'FR',
 'es':'ES', 'español':'ES', 'ru':'RU', 'русский':'RU',
 'auto':'AUTO', '自动':'AUTO', '自動':'AUTO', '自动检测':'AUTO', '自動偵測':'AUTO'
};
export function shortLangLabel(label: string): string {
 const text=label.trim();
 return LABELS[text.toLowerCase()] ?? text.toUpperCase();
}
